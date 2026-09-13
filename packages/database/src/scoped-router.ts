import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
type Client = ReturnType<typeof postgres>;
type Release = () => Promise<void>;
type Scope = {
  client: Client;
  organizationId: string | null;
  userId: string | null;
  transaction: boolean;
  closed: boolean;
  cleanup: Set<Release>;
};
export const DATABASE_ORGANIZATION = Symbol("database.organization");
export const DATABASE_ADVISORY_LOCK = Symbol("database.advisory-lock");

/** Each independent query receives a short RLS transaction. Explicit begin()
 * groups remain atomic, without holding transactions across network callbacks. */
export function createScopedDatabaseRouter(
  tenantPool: Client,
  lockPool: Client = tenantPool,
) {
  const storage = new AsyncLocalStorage<Scope>();
  const current = () => {
    const scope = storage.getStore();
    if (!scope || scope.closed) throw new Error("DATABASE_SCOPE_REQUIRED");
    return scope;
  };
  async function inside<T>(
    scope: Scope,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await storage.run(scope, callback);
    } finally {
      try {
        for (const release of scope.cleanup) await release();
      } finally {
        scope.closed = true;
      }
    }
  }
  async function transaction<T>(
    scope: Scope,
    callback: (tx: Client) => Promise<T>,
  ): Promise<T> {
    if (scope.transaction) return callback(scope.client);
    return scope.client.begin(async (tx) => {
      if (scope.organizationId !== null)
        await tx`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scope.userId ?? ""}, true)`;
      return callback(tx as unknown as Client);
    }) as Promise<T>;
  }
  function query(scope: Scope, factory: (client: Client) => unknown): unknown {
    const placeholder = factory(scope.client);
    if (
      !placeholder ||
      typeof placeholder !== "object" ||
      !("then" in placeholder)
    )
      return placeholder;
    const modifiers: Array<[PropertyKey, unknown[]]> = [];
    let execution: Promise<unknown> | undefined;
    const execute = () => {
      if (scope.closed || storage.getStore() !== scope)
        throw new Error("DATABASE_QUERY_ESCAPED_SCOPE");
      execution ??= transaction(scope, async (tx) => {
        let actual = factory(tx) as object;
        for (const [key, args] of modifiers)
          actual = Reflect.apply(Reflect.get(actual, key), actual, args);
        return await actual;
      });
      return execution;
    };
    const facade = new Proxy(placeholder, {
      get(target, key) {
        if (key === "then" || key === "catch" || key === "finally")
          return (...args: unknown[]) =>
            Reflect.apply(Reflect.get(execute(), key), execute(), args);
        if (key === "execute")
          return () => {
            void execute();
            return facade;
          };
        if (["simple", "raw", "values", "describe"].includes(String(key)))
          return (...args: unknown[]) => {
            modifiers.push([key, args]);
            return facade;
          };
        if (
          ["cursor", "readable", "writable", "forEach", "cancel"].includes(
            String(key),
          )
        )
          return () => {
            throw new Error("SCOPED_QUERY_OPERATION_UNSUPPORTED");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return facade;
  }
  const sql = new Proxy(tenantPool, {
    apply(_target, thisArg, args) {
      return query(current(), (client) => Reflect.apply(client, thisArg, args));
    },
    get(_target, key) {
      if (key === "json" || key === "array") {
        const helper = Reflect.get(tenantPool, key);
        return typeof helper === "function" ? helper.bind(tenantPool) : helper;
      }
      const scope = current();
      if (key === DATABASE_ORGANIZATION) return scope.organizationId;
      if (key === DATABASE_ADVISORY_LOCK)
        return async (organizationId: string) => {
          if (
            scope.organizationId !== null &&
            organizationId !== scope.organizationId
          )
            throw new Error("TENANT_SCOPE_SWITCH_DENIED");
          if (scope.transaction) {
            await scope.client`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId},0))`;
            return { release: async () => {} };
          }
          const reserved = await lockPool.reserve();
          try {
            await reserved`SELECT pg_advisory_lock(hashtextextended(${organizationId},0))`;
          } catch (error) {
            reserved.release();
            throw error;
          }
          let released = false;
          const release = async () => {
            if (released) return;
            released = true;
            try {
              await reserved`SELECT pg_advisory_unlock(hashtextextended(${organizationId},0))`;
            } finally {
              reserved.release();
              scope.cleanup.delete(release);
            }
          };
          scope.cleanup.add(release);
          return { release };
        };
      if (key === "end" || key === "reserve")
        throw new Error("DATABASE_POOL_OPERATION_INSIDE_SCOPE");
      if (key === "begin" || key === "savepoint")
        return (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback !== "function")
            throw new Error("DATABASE_TRANSACTION_CALLBACK_REQUIRED");
          const wrapped = (tx: Client) =>
            inside(
              {
                client: tx,
                organizationId: scope.organizationId,
                userId: scope.userId,
                transaction: true,
                closed: false,
                cleanup: new Set(),
              },
              () => callback(tx),
            );
          if (scope.transaction) {
            if (key === "begin" && args.length !== 1)
              throw new Error("NESTED_TRANSACTION_OPTIONS_UNSUPPORTED");
            return Reflect.apply(
              Reflect.get(scope.client, "savepoint"),
              scope.client,
              key === "savepoint" && args.length === 2
                ? [args[0], wrapped]
                : [wrapped],
            );
          }
          if (key === "savepoint")
            throw new Error("DATABASE_TRANSACTION_REQUIRED");
          if (args.length !== 1)
            throw new Error("SCOPED_TRANSACTION_OPTIONS_UNSUPPORTED");
          return transaction(scope, wrapped);
        };
      if (key === "unsafe")
        return (...args: unknown[]) =>
          query(scope, (client) => Reflect.apply(client.unsafe, client, args));
      const value = Reflect.get(scope.client, key);
      if (typeof value === "function")
        throw new Error("SCOPED_DATABASE_OPERATION_UNSUPPORTED");
      return value;
    },
  });
  async function tenant<T>(
    organizationId: string,
    callback: () => Promise<T>,
    userId?: string,
  ): Promise<T> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        organizationId,
      )
    )
      throw new Error("INVALID_TENANT_SCOPE");
    const parent = storage.getStore();
    if (parent) {
      if (parent.closed || parent.organizationId !== organizationId)
        throw new Error("TENANT_SCOPE_SWITCH_DENIED");
      return callback();
    }
    return inside(
      {
        client: tenantPool,
        organizationId,
        userId: userId ?? null,
        transaction: false,
        closed: false,
        cleanup: new Set(),
      },
      callback,
    );
  }
  async function control<T>(
    pool: Client,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (storage.getStore())
      throw new Error("DATABASE_PRIVILEGE_ESCALATION_DENIED");
    return inside(
      {
        client: pool,
        organizationId: null,
        userId: null,
        transaction: false,
        closed: false,
        cleanup: new Set(),
      },
      callback,
    );
  }
  return { sql, tenant, control };
}

import type postgres from "postgres";
import type { TransactionSql } from "postgres";

type DatabaseClient = ReturnType<typeof postgres>;

/**
 * Database gateway for the automation bounded context.
 *
 * SQL stays in the database package even while the legacy automation routes
 * are incrementally converted to query-specific repository methods.
 */
export class AutomationRepository {
  constructor(private readonly client: DatabaseClient) {}

  async query<T = Array<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    return (await this.client(strings, ...(values as never[]))) as unknown as T;
  }

  begin<T>(callback: (transaction: TransactionSql) => Promise<T>): Promise<T> {
    return this.client.begin(callback as never) as unknown as Promise<T>;
  }
}

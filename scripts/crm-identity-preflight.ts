import { createDatabase } from "../packages/database/src/index";

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

async function main() {
  const { client } = createDatabase(requireDatabaseUrl());
  try {
    const [
      contactDuplicates,
      conversationDuplicates,
      linkConflicts,
      messageDuplicates,
    ] = await Promise.all([
      client<Array<Record<string, unknown>>>`
          SELECT organization_id,
            concat(left(normalized_phone,3),'***',right(normalized_phone,2)) masked_phone,
            count(*)::int record_count,array_agg(id ORDER BY created_at) record_ids
          FROM contacts
          GROUP BY organization_id,normalized_phone
          HAVING count(*)>1
          ORDER BY count(*) DESC`,
      client<Array<Record<string, unknown>>>`
          SELECT organization_id,channel_id,contact_id,status,count(*)::int record_count,
            array_agg(id ORDER BY created_at) conversation_ids
          FROM conversations
          GROUP BY organization_id,channel_id,contact_id,status
          HAVING count(*)>1
          ORDER BY count(*) DESC`,
      client<Array<Record<string, unknown>>>`
          SELECT link.organization_id,link.connection_id,
            COALESCE(link.contact_id,conversation.contact_id) contact_id,link.entity_type,
            count(DISTINCT link.external_id)::int external_id_count,
            array_agg(DISTINCT link.external_id) external_ids,
            array_agg(DISTINCT link.conversation_id) conversation_ids
          FROM crm_entity_links link
          LEFT JOIN conversations conversation
            ON conversation.id=link.conversation_id
           AND conversation.organization_id=link.organization_id
          WHERE link.unavailable_at IS NULL
            AND COALESCE(link.contact_id,conversation.contact_id) IS NOT NULL
          GROUP BY link.organization_id,link.connection_id,
            COALESCE(link.contact_id,conversation.contact_id),link.entity_type
          HAVING count(DISTINCT link.external_id)>1
          ORDER BY count(DISTINCT link.external_id) DESC`,
      client<Array<Record<string, unknown>>>`
          SELECT organization_id,channel_id,provider_message_id,count(*)::int record_count,
            array_agg(id ORDER BY created_at) message_ids
          FROM messages
          WHERE provider_message_id IS NOT NULL
          GROUP BY organization_id,channel_id,provider_message_id
          HAVING count(*)>1
          ORDER BY count(*) DESC`,
    ]);

    const report = {
      mode: "read_only",
      generatedAt: new Date().toISOString(),
      summary: {
        duplicateContactGroups: contactDuplicates.length,
        duplicateConversationGroups: conversationDuplicates.length,
        conflictingCrmIdentityGroups: linkConflicts.length,
        duplicateProviderMessageGroups: messageDuplicates.length,
      },
      findings: {
        contacts: contactDuplicates,
        conversations: conversationDuplicates,
        crmIdentities: linkConflicts,
        providerMessages: messageDuplicates,
      },
      nextStep:
        "Review conflicts manually before any transaction-based merge; this command performs no writes.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "CRM identity preflight failed",
  );
  process.exitCode = 1;
});

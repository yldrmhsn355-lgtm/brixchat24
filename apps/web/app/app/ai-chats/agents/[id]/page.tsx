import { AiAgentDetail } from "../../../../../components/ai-agent-detail";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AiAgentDetail agentId={id} />;
}

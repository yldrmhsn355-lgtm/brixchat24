import { AiKnowledgeDetail } from "../../../../../components/ai-knowledge-detail";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AiKnowledgeDetail baseId={id} />;
}

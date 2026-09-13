import { AutomationRunsWorkspace } from "../../../../../components/automation-runs-workspace";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AutomationRunsWorkspace ruleId={id} />;
}

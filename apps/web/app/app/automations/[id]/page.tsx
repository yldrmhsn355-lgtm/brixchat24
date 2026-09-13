import { AutomationStudio } from "../../../../components/automation-studio";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationStudio automationId={id} />;
}

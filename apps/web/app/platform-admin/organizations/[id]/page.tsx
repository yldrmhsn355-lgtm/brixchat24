import { OrganizationDetailPage } from "../../_components/platform-admin";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OrganizationDetailPage id={id} />;
}

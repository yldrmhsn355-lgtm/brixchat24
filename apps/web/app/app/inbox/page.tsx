import { InboxWorkspace } from "./workspace";

// The inbox is an authenticated, live workspace. Serving its HTML through the
// static page cache can pin users to an old client bundle after a deployment.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function InboxPage() {
  return <InboxWorkspace />;
}

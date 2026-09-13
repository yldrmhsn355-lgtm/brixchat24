import { AppFrame } from "../../../components/app-frame";
import { FilesWorkspace } from "../../../components/files-workspace";

export default function FilesPage() {
  return (
    <AppFrame
      title="Dosyalar ve Belgeler"
      subtitle="WhatsApp medyaları, hasta dosyaları ve bağlı depolama hesapları tek güvenli alanda."
    >
      <FilesWorkspace />
    </AppFrame>
  );
}

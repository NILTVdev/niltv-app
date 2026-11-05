import { api } from "../../api";

/**
 * Open a sent file in a new tab. The tab opens before the link arrives,
 * because phones block a window opened after waiting on the network.
 */
export async function openFile(askId: string, sub: string, fileId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const { url } = await api.fileUrl(askId, sub, fileId);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Copies text to the clipboard; throws "copy_failed" when it cannot. */
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("copy_failed");
  await navigator.clipboard.writeText(text);
}

// Convert an ArrayBuffer to a base64 string. Uses FileReader for speed
// on multi-MB PDF inputs (10–100× faster than the String.fromCharCode
// loop for big buffers).
export async function arrayBufferToBase64(buf: ArrayBuffer): Promise<string> {
  const blob = new Blob([buf]);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
  // Strip the "data:<mime>;base64," prefix.
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

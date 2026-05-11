export async function POST(req: Request) {
  const form = await req.formData();
  return Response.json({ size: (form.get("file") as File | null)?.size ?? 0 });
}

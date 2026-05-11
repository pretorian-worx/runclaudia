export async function GET() {
  return Response.json({ bugs: [] });
}

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ id: "stub", title: body.title }, { status: 201 });
}

// @ts-nocheck — fixture file; the `@/lib/db` import doesn't resolve in this
// minimal monorepo example but is fine for static analysis tests.
import { db } from "@/lib/db";

export async function GET() {
  const bugs = await db.bug.findMany();
  return Response.json({ bugs });
}

export async function POST(req: Request) {
  const body = await req.json();
  const bug = await db.bug.create({ data: { title: body.title } });
  return Response.json(bug, { status: 201 });
}

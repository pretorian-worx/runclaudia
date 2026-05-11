import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return Response.json({ error: "no file" }, { status: 400 });

  const key = `attachments/${crypto.randomUUID()}`;
  await s3.send(new PutObjectCommand({ Bucket: "fixture-attachments", Key: key, Body: Buffer.from(await file.arrayBuffer()) }));
  await ddb.send(new PutItemCommand({ TableName: "fixture-attachments", Item: { id: { S: key }, size: { N: String(file.size) } } }));

  return Response.json({ key }, { status: 201 });
}

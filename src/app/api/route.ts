import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ name: "Bot Factory API", status: "operational" }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
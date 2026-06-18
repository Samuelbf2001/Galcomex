import { NextResponse } from "next/server";

export function jsonResponse<T>(data: T, init?: ResponseInit) {
  return new NextResponse(
    JSON.stringify(data, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    },
  );
}

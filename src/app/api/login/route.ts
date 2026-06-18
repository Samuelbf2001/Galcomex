import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth/auth";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const callbackURL = String(formData.get("callbackURL") ?? "/dashboard");
  const origin = request.nextUrl.origin;

  const authResponse = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({
        email,
        password,
        callbackURL,
      }),
    }),
  );

  if (!authResponse.ok) {
    const loginUrl = new URL("/auth/login", origin);
    loginUrl.searchParams.set("error", "credenciales");
    loginUrl.searchParams.set("next", callbackURL);
    return NextResponse.redirect(loginUrl);
  }

  const redirectTo = callbackURL.startsWith("/") ? callbackURL : "/dashboard";
  const response = NextResponse.redirect(new URL(redirectTo, origin));
  const setCookie = authResponse.headers.get("set-cookie");

  if (setCookie) {
    response.headers.set("set-cookie", setCookie);
  }

  return response;
}

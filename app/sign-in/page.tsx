import { AuthGate } from "@/components/auth-gate";
import { isAuthConfigured } from "@/lib/auth";

export default function SignInPage() {
  return <AuthGate configured={isAuthConfigured()} />;
}

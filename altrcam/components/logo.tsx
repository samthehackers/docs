import Link from "next/link";
import { Camera } from "lucide-react";
export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight" aria-label="AltrCam home">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent"><Camera className="h-4 w-4 text-white" aria-hidden /></span>
      <span className="text-lg">Altr<span className="gradient-text">Cam</span></span>
    </Link>
  );
}

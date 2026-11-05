import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#FAF7F2]">
      <h1 className="sr-only">Page not found</h1>
      <div className="relative aspect-video w-full max-w-[1920px]">
        <img
          src="https://msxfhfdeqxqvjuypcspm.supabase.co/storage/v1/object/public/photos/totec-404.svg"
          alt="404 page illustration"
          className="absolute inset-0 h-full w-full"
        />
        <Button
          asChild
          className="absolute left-1/2 top-[72%] -translate-x-1/2 rounded-none bg-black px-8 text-white hover:bg-[#E2553B]"
        >
          <Link href="/">Back To The Past!</Link>
        </Button>
      </div>
    </main>
  );
}

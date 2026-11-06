import { useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#FAF7F2]">
      <h1 className="sr-only">Page not found</h1>
      <div className="absolute inset-0">
        <img
          src="https://msxfhfdeqxqvjuypcspm.supabase.co/storage/v1/object/public/photos/totec-404.svg"
          alt="404 page illustration"
          className="absolute inset-0 h-full w-full object-cover object-[center_60%]"
        />
        <Button
          asChild
          className="absolute left-1/2 top-[72%] -translate-x-1/2 rounded-none bg-black px-8 text-white hover:bg-[#80d7f6]"
        >
          <Link href="/">Back To The Past!</Link>
        </Button>
      </div>
    </main>
  );
}

import { Link } from "wouter";
import { useGetContent, useListProducts } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { FaqSection } from "@/components/faq-section";
import { formatPrice } from "@/lib/format";
import { useCart } from "@/lib/cart";
import { toast } from "sonner";

function customSectionDocument(section: {
  html: string;
  css: string;
  js: string;
}): string {
  const css = section.css.replace(/<\/style/gi, "<\\/style");
  const js = section.js.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}*{box-sizing:border-box}${css}</style></head><body>${section.html}<script>${js}</script></body></html>`;
}

export default function Home() {
  const {
    data: content,
    isLoading: contentLoading,
    isError: contentError,
  } = useGetContent();
  const {
    data: products,
    isLoading: productsLoading,
    isError: productsError,
  } = useListProducts();
  const { addItem } = useCart();

  if (contentLoading || productsLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#FAF7F2]">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
        </div>
      </div>
    );
  }

  if (contentError || productsError || !content) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#FAF7F2] px-6">
        <div className="max-w-lg text-center">
          <p className="text-sm font-bold uppercase tracking-[0.24em] text-black/50">
            Store status
          </p>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-black">
            We couldn’t load the storefront.
          </h1>
          <p className="mt-4 text-black/60">
            The site is temporarily unable to reach the API. Please refresh the
            page or try again in a few minutes.
          </p>
        </div>
      </div>
    );
  }

  const activeProducts =
    products?.filter((p) => p.active && p.showInShop) || [];

  const handleAddToCart = (productId: number) => {
    addItem(productId);
    toast.success("Added to cart");
  };

  return (
    <div
      className="min-h-screen w-full flex flex-col font-sans bg-[#FAF7F2]"
      style={{ "--theme-accent": content.accentColor } as React.CSSProperties}
    >
      <SiteHeader />

      {content.ordersEnabled === false && (
        <div className="w-full bg-amber-50 border-b border-amber-200 px-6 py-4 text-center">
          <p className="text-amber-800 font-semibold text-sm uppercase tracking-widest">
            We are not accepting orders at this time. Check back soon!
          </p>
        </div>
      )}

      <main className="flex-1 w-full flex flex-col">
        {/* Hero Section */}
        <section
          className="w-full min-h-[85vh] flex items-center"
          style={{ order: content.homeSectionOrder.indexOf("hero") }}
        >
          <div className="w-full max-w-[1600px] mx-auto flex flex-col md:flex-row items-stretch md:items-center">
            {/* Left Column - Text */}
            <div className="w-full md:w-[45%] px-6 md:pl-[12%] py-12 md:py-0 flex flex-col justify-center z-10">
              <h1 className="text-black text-5xl sm:text-6xl md:text-[5.5rem] lg:text-[6.5rem] font-bold leading-[1.05] tracking-tight">
                {content.heroTitle}
              </h1>
              <p className="mt-8 text-black/60 text-base md:text-lg max-w-sm font-medium">
                {content.heroSubtitle}
              </p>
              <div className="mt-12">
                <Button
                  asChild
                  size="lg"
                  className="rounded-full bg-white text-black border border-black hover:text-white transition-all duration-300 px-12 py-7 text-[15px] tracking-wide font-medium shadow-none h-auto w-fit hover:bg-[var(--theme-accent)] hover:border-[var(--theme-accent)]"
                >
                  <Link href={content.ctaUrl || "/shop"}>
                    {content.ctaLabel}
                  </Link>
                </Button>
              </div>
            </div>

            {/* Right Column - Image */}
            <div className="w-full md:w-[55%] flex justify-center items-center px-6 md:px-0 pb-12 md:pb-0 h-[45vh] min-h-[280px] md:h-[85vh]">
              <img
                src={content.coverImageUrl}
                alt="Book Cover"
                className="w-full h-full object-contain max-h-[800px]"
              />
            </div>
          </div>
        </section>

        {/* Shop Section */}
        <section
          id="shop"
          className="px-4 py-16 sm:px-6 sm:py-24 lg:py-32 bg-white"
          style={{ order: content.homeSectionOrder.indexOf("shop") }}
        >
          <div className="max-w-[1400px] mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-black mb-16 text-center">
              Shop
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 sm:gap-12">
              {activeProducts.map((product) => (
                <div key={product.id} className="flex flex-col group">
                  <Link
                    href={`/product/${product.id}`}
                    className="block aspect-[3/4] bg-[#FAF7F2] mb-6 overflow-hidden relative p-8 flex items-center justify-center hover:opacity-90 transition-opacity"
                  >
                    <img
                      src={
                        product.imageUrl ||
                        "https://placehold.co/400x600?text=No+Image"
                      }
                      alt={product.name}
                      className="w-full h-full object-contain mix-blend-multiply group-hover:scale-105 transition-transform duration-500"
                    />
                  </Link>
                  <div className="flex flex-col flex-1">
                    <Link
                      href={`/product/${product.id}`}
                      className="text-xl font-bold text-black mb-2 hover:text-[var(--theme-accent)] transition-colors"
                    >
                      {product.name}
                    </Link>
                    <p className="text-black/60 mb-6">
                      {formatPrice(product.priceCents, product.currency)}
                    </p>
                    <div className="mt-auto">
                      <Button
                        onClick={() => handleAddToCart(product.id)}
                        className="w-full rounded-none bg-black hover:bg-[var(--theme-accent)] text-white py-6 font-bold uppercase tracking-widest text-xs transition-colors"
                        disabled={product.stock <= 0}
                      >
                        {product.stock > 0 ? "Add to Cart" : "Out of Stock"}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {activeProducts.length === 0 && (
              <p className="text-center text-black/50 text-lg py-12">
                No products available right now.
              </p>
            )}
          </div>
        </section>

        {/* About Section */}
        <section
          className="px-4 py-16 sm:px-6 sm:py-24 lg:py-32 bg-[#FAF7F2]"
          style={{ order: content.homeSectionOrder.indexOf("about") }}
        >
          <div className="max-w-2xl mx-auto text-center space-y-10">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-black">
              {content.aboutHeading}
            </h2>
            <div className="text-lg md:text-xl text-black/70 leading-relaxed font-medium">
              <p>{content.aboutBody}</p>
            </div>
            <div className="pt-12 flex flex-col sm:flex-row justify-center gap-4 sm:gap-12 text-sm text-black/50 uppercase tracking-widest font-bold">
              <span>By {content.authorsLine}</span>
              <span>Illustrated by {content.illustratorLine}</span>
            </div>
          </div>
        </section>

        <div style={{ order: content.homeSectionOrder.indexOf("faq") }}>
          <FaqSection showAllLink />
        </div>
        {content.homeCustomSections.map((section) => (
          <iframe
            key={section.id}
            title={section.name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={customSectionDocument(section)}
            className="w-full border-0"
            style={{
              order: content.homeSectionOrder.indexOf(section.id),
              minHeight: 360,
            }}
          />
        ))}
      </main>

      <SiteFooter />
    </div>
  );
}

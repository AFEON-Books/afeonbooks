import { useState } from "react";
import { Link, useParams } from "wouter";
import { useGetContent, useGetOrder } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { formatPrice } from "@/lib/format";
import { CheckCircle2, Printer } from "lucide-react";

export default function Order() {
  const { id } = useParams();
  const orderId = parseInt(id || "0", 10);
  const accessToken = new URLSearchParams(window.location.hash.slice(1)).get("access_token") ?? "";
  const [receiptError, setReceiptError] = useState("");
  const { data: content } = useGetContent();
  const { data: order, isLoading, isError } = useGetOrder(orderId, {
    request: {
      headers: accessToken ? { "X-Order-Access-Token": accessToken } : undefined,
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-[#FAF7F2]">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full border-4 border-black border-t-transparent animate-spin"></div>
        </div>
      </div>
    );
  }

  if (isError || !order) {
    return (
      <div className="min-h-screen w-full flex flex-col bg-[#FAF7F2]">
        <SiteHeader simple />
        <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
          <h1 className="text-3xl font-bold mb-4">Order Not Found</h1>
          <p className="text-black/60 mb-8">We couldn't find the order you're looking for.</p>
          <Button asChild className="rounded-full bg-black text-white px-8">
            <Link href="/">Back Home</Link>
          </Button>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const printReceipt = async () => {
    setReceiptError("");
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const response = await fetch(`/order/${order.id}/pdf`, {
        headers: accessToken ? { "X-Order-Access-Token": accessToken } : undefined,
      });
      if (!response.ok) throw new Error("Unable to load the receipt.");

      const pdfUrl = URL.createObjectURL(await response.blob());
      if (popup) popup.location.href = pdfUrl;
      else window.location.assign(pdfUrl);
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
    } catch (error) {
      popup?.close();
      setReceiptError(error instanceof Error ? error.message : "Unable to load the receipt.");
    }
  };

  return (
    <div
      className="min-h-screen w-full flex flex-col font-sans bg-[#FAF7F2]"
      style={{ "--theme-accent": content?.accentColor || "#000" } as React.CSSProperties}
    >
      <SiteHeader simple />

      <main className="flex-1 w-full px-6 py-12 md:py-24">
        <div className="max-w-[800px] mx-auto bg-white p-8 md:p-16 border border-black/5 shadow-sm">
          <div className="text-center mb-16">
            <div className="w-20 h-20 bg-green-50 text-green-600 rounded-full flex items-center justify-center mx-auto mb-8">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight mb-4">Thank you for your order!</h1>
            <p className="text-lg text-black/60 font-medium">Order #{order.id} has been placed successfully.</p>
            <div className="mt-8 inline-block bg-[#FAF7F2] border border-black/10 px-6 py-3 rounded-full text-sm font-bold tracking-widest uppercase">
              Status: <span className="text-[var(--theme-accent)] ml-2">{order.status}</span>
            </div>
          </div>

          <div className="bg-[#FAF7F2]/50 border border-black/10 p-6 md:p-8 mb-12 text-center">
            <h2 className="text-xl font-bold mb-2">Cash on Delivery</h2>
            <p className="text-black/70 font-medium">Please have {formatPrice(order.totalCents, order.currency)} ready in cash when your order arrives.</p>
          </div>

          <div className="grid md:grid-cols-2 gap-12 mb-12">
            <div>
              <h3 className="text-xs uppercase tracking-widest text-black/50 font-bold mb-4">Customer Info</h3>
              <div className="font-medium space-y-1">
                <p>{order.customerName}</p>
                <p>{order.customerEmail}</p>
                <p>Student ID: {order.customerPhone}</p>
              </div>
            </div>
            <div>
              <h3 className="text-xs uppercase tracking-widest text-black/50 font-bold mb-4">Shipping Address</h3>
              <div className="font-medium space-y-1">
                {order.useDefaultAddress && order.classroom && <p className="font-bold">Classroom {order.classroom}</p>}
                <p>{order.shippingAddress}</p>
                <p>{order.city}, {order.postalCode}</p>
                <p>{order.country}</p>
              </div>
            </div>
          </div>

          <div className="border-t border-black/10 pt-8 mb-12">
            <h3 className="text-xs uppercase tracking-widest text-black/50 font-bold mb-6">Order Items</h3>
            <div className="space-y-4">
              {order.items.map((item) => (
                <div key={item.id} className="flex justify-between items-center font-medium border-b border-black/5 pb-4 last:border-0 last:pb-0">
                  <div className="flex items-center gap-4">
                    <span className="bg-[#FAF7F2] text-black text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center">{item.quantity}</span>
                    <span>{item.productName}</span>
                  </div>
                  <span>{formatPrice(item.unitPriceCents * item.quantity)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-black/10 pt-8 flex justify-between items-end">
            <span className="text-sm uppercase tracking-widest text-black/50 font-bold">Total</span>
            <span className="text-3xl font-bold">{formatPrice(order.totalCents, order.currency)}</span>
          </div>

          <div className="mt-16 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button type="button" onClick={printReceipt} className="h-14 px-10 rounded-full bg-black text-white hover:bg-[var(--theme-accent)] transition-colors uppercase tracking-widest font-bold text-xs">
              <Printer className="w-4 h-4 mr-2" />
              Print Receipt
            </Button>
            <Button asChild className="h-14 px-10 rounded-full bg-black text-white hover:bg-[var(--theme-accent)] transition-colors uppercase tracking-widest font-bold text-xs">
              <Link href="/shop">Continue Shopping</Link>
            </Button>
          </div>
          {receiptError && <p role="alert" className="mt-4 text-center text-sm text-red-700">{receiptError}</p>}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

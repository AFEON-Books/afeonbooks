import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useGetContent, useCreateOrder, getGetOrdersSummaryQueryKey, getListOrdersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { formatPrice } from "@/lib/format";
import { useCart } from "@/lib/cart";
import { useUtm, utmPayload } from "@/lib/utm";
import { toast } from "sonner";
import { authApiRequest, createAuthEntryUrl, useAuth } from "@/lib/auth";

const CUSTOM_ADDRESS_SHIPPING_FEE_CENTS = 500;

const checkoutSchema = z
  .object({
    customerName: z.string().min(1, "Name is required"),
    customerEmail: z.string().email("Invalid email address"),
    customerPhone: z.string().min(3, "Student ID is required"),
    useDefaultAddress: z.boolean(),
    shippingAddressId: z.string().optional(),
    classroom: z.string().optional(),
    shippingAddress: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
    notes: z.string().optional(),
    customFields: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((values, ctx) => {
    if (values.useDefaultAddress) {
      if (!values.shippingAddressId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shippingAddressId"],
          message: "Please choose a shipping address",
        });
      }
      if (!values.classroom || values.classroom.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["classroom"],
          message: "Classroom Number is required",
        });
      }
    } else {
      if (!values.shippingAddress || values.shippingAddress.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shippingAddress"], message: "Address is required" });
      }
      if (!values.city || values.city.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["city"], message: "City is required" });
      }
      if (!values.postalCode || values.postalCode.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["postalCode"], message: "Postal code is required" });
      }
      if (!values.country || values.country.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["country"], message: "Country is required" });
      }
    }
  });

type CheckoutValues = z.infer<typeof checkoutSchema>;

export default function Checkout() {
  const [, setLocation] = useLocation();
  const { user, loading: authLoading } = useAuth();
  const { data: content } = useGetContent();
  const { enrichedItems, itemCount, clear } = useCart();
  const { utm, clear: clearUtm } = useUtm();
  const createOrder = useCreateOrder();
  const queryClient = useQueryClient();
  const [loyaltyBalance, setLoyaltyBalance] = useState(0);
  const [pointsToRedeem, setPointsToRedeem] = useState("");
  const [redeemedPoints, setRedeemedPoints] = useState(0);
  const [promoInput, setPromoInput] = useState("");
  const [appliedPromoCode, setAppliedPromoCode] = useState("");
  const [promoDiscountCents, setPromoDiscountCents] = useState(0);
  const [promoBusy, setPromoBusy] = useState(false);

  const shippingAddresses = content?.shippingAddresses ?? [];
  const hasDefaultAddress = shippingAddresses.length > 0;

  const subtotalCents = enrichedItems.reduce((sum, item) => {
    const price = item.product?.priceCents || 0;
    return sum + price * item.quantity;
  }, 0);
  const estimatedPoints = Math.floor(subtotalCents / 100) * (content?.loyaltyPagesPerDollar ?? 50);
  const loyaltyDiscountCents = (redeemedPoints / 1000) * 1000;

  useEffect(() => {
    if (!user) {
      setLoyaltyBalance(0);
      setRedeemedPoints(0);
      return;
    }
    authApiRequest<{ balance: number }>("/api/auth/loyalty")
      .then((data) => setLoyaltyBalance(data.balance))
      .catch(() => setLoyaltyBalance(0));
  }, [user]);

  const redeemPoints = () => {
    const points = Number(pointsToRedeem);
    if (!Number.isInteger(points) || points < 1000 || points % 1000 !== 0) {
      toast.error("Redeem Pages in 1,000-Page increments.");
      return;
    }
    if (points > loyaltyBalance) {
      toast.error("You do not have enough Pages.");
      return;
    }
    setRedeemedPoints(points);
    toast.success(`${points.toLocaleString()} Pages selected for redemption.`);
  };

  const form = useForm<CheckoutValues>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      customerName: "",
      customerEmail: "",
      customerPhone: "",
      useDefaultAddress: false,
      shippingAddressId: "",
      classroom: "",
      shippingAddress: "",
      city: "",
      postalCode: "",
      country: "",
      notes: "",
      customFields: {},
    },
  });

  const useDefaultAddress = form.watch("useDefaultAddress");
  const selectedShippingAddress = shippingAddresses.find((address) => address.id === form.watch("shippingAddressId"));
  const shippingCents = useDefaultAddress
    ? selectedShippingAddress?.shippingFeeCents ?? 0
    : CUSTOM_ADDRESS_SHIPPING_FEE_CENTS;
  const totalCents = Math.max(0, subtotalCents - loyaltyDiscountCents - promoDiscountCents) + shippingCents;

  const applyPromoCode = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoBusy(true);
    try {
      const response = await fetch("/api/promo-codes/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, subtotalCents }),
      });
      const data = await response.json() as { valid?: boolean; code?: string; discountCents?: number; error?: string };
      if (!response.ok || !data.valid) throw new Error(data.error ?? "This promo code is unavailable.");
      setAppliedPromoCode(data.code ?? code);
      setPromoDiscountCents(data.discountCents ?? 0);
      setPromoInput(data.code ?? code);
      toast.success("Promo code applied");
    } catch (error) {
      setAppliedPromoCode("");
      setPromoDiscountCents(0);
      toast.error(error instanceof Error ? error.message : "Unable to apply promo code");
    } finally {
      setPromoBusy(false);
    }
  };

  const addressSetup = useRef(false);
  useEffect(() => {
    if (!content || addressSetup.current) return;
    addressSetup.current = true;
    if (content.shippingAddresses.length > 0) {
      form.setValue("shippingAddressId", content.shippingAddresses[0]!.id);
      form.setValue("useDefaultAddress", true);
    }
  }, [content, form]);

  const onSubmit = (values: CheckoutValues) => {
    if (itemCount === 0) {
      toast.error("Your cart is empty");
      return;
    }
    const missingField = (content?.checkoutFields ?? []).find((field) => field.required && !(values.customFields?.[field.id] ?? "").trim());
    if (missingField) {
      form.setError(`customFields.${missingField.id}`, { message: `${missingField.label} is required` });
      toast.error(`Please complete ${missingField.label}`);
      return;
    }

    const items = enrichedItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));

    const utmFields = utmPayload(utm);
    const payload = values.useDefaultAddress
      ? {
           customerName: values.customerName,
          customerEmail: values.customerEmail,
          customerPhone: values.customerPhone,
          useDefaultAddress: true,
          shippingAddressId: values.shippingAddressId,
          classroom: values.classroom?.trim() ?? "",
          notes: values.notes,
          promoCode: appliedPromoCode || undefined,
           customFields: values.customFields,
          items,
          ...utmFields,
        }
      : {
           customerName: values.customerName,
          customerEmail: values.customerEmail,
          customerPhone: values.customerPhone,
          useDefaultAddress: false,
          shippingAddress: values.shippingAddress?.trim() ?? "",
          city: values.city?.trim() ?? "",
          postalCode: values.postalCode?.trim() ?? "",
          country: values.country?.trim() ?? "",
          notes: values.notes,
          promoCode: appliedPromoCode || undefined,
           customFields: values.customFields,
          items,
          ...utmFields,
        };

    createOrder.mutate({ data: payload }, {
      onSuccess: (order) => {
        clear();
        clearUtm();
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetOrdersSummaryQueryKey() });
        setLocation(`/order/${order.id}#access_token=${encodeURIComponent(order.accessToken)}`);
      },
      onError: () => {
        toast.error("Failed to place order. Please try again.");
      }
    });
  };

  if (content?.ordersEnabled === false) {
    return (
      <div className="min-h-screen w-full flex flex-col bg-[#FAF7F2]">
        <SiteHeader simple />
        <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-3xl font-bold mb-4">Orders are currently paused</h1>
          <p className="text-black/60 mb-8 max-w-sm">We're not accepting new orders right now. Please check back soon!</p>
          <Button asChild className="rounded-full bg-black text-white px-8">
            <Link href="/shop">Back to Shop</Link>
          </Button>
        </main>
      </div>
    );
  }

  if (itemCount === 0) {
    return (
      <div className="min-h-screen w-full flex flex-col bg-[#FAF7F2]">
        <SiteHeader simple />
        <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <h1 className="text-3xl font-bold mb-4">Your cart is empty</h1>
          <Button asChild className="rounded-full bg-black text-white px-8 mt-4">
            <Link href="/shop">Go to Shop</Link>
          </Button>
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div 
      className="min-h-screen w-full flex flex-col font-sans bg-[#FAF7F2]"
      style={{ "--theme-accent": content?.accentColor || "#000" } as React.CSSProperties}
    >
      <SiteHeader simple />

      <main className="flex-1 w-full px-6 py-12">
        {!authLoading && !user && (
          <div className="mx-auto mb-8 flex max-w-[1200px] flex-col gap-4 border border-[#B8860B] bg-[#D4A72C] px-5 py-4 text-black sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-bold">Log in to get "Pages"!</p>
              <p className="mt-1 text-sm text-black/55">Create an account or sign in to track your Pages and keep your orders in one place.</p>
            </div>
            <Button asChild variant="outline" className="w-fit shrink-0 rounded-none border-black/25 text-xs font-bold uppercase tracking-widest">
              <a href={createAuthEntryUrl(false)}>Sign in or create account</a>
            </Button>
          </div>
        )}

        {!authLoading && user && loyaltyBalance > 0 && (
          <div className="mx-auto mb-8 flex max-w-[1200px] flex-col gap-4 border border-[#B8860B] bg-[#D4A72C] px-5 py-4 text-black sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-bold">Redeem your Pages</p>
              <p className="mt-1 text-sm text-black/55">You have {loyaltyBalance.toLocaleString()} Pages ready to use on a product.</p>
            </div>
            <Button asChild variant="outline" className="w-fit shrink-0 rounded-none border-black/25 text-xs font-bold uppercase tracking-widest">
              <Link href="/redeem-pages">Redeem now</Link>
            </Button>
          </div>
        )}
        <div className="max-w-[1200px] mx-auto flex flex-col-reverse lg:flex-row gap-12 lg:gap-20 items-start">
          
          {/* Checkout Form */}
          <div className="w-full lg:w-[60%]">
            <div className="mb-12">
              <h1 className="text-3xl font-bold tracking-tight mb-2">Checkout</h1>
              <p className="text-black/50 font-medium">Please enter your shipping details.</p>
              <img
                src="/powered-with-square.png"
                alt="Built with Square"
                className="mt-4 h-auto w-48"
              />

            </div>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-10">
                {(content?.checkoutFields ?? []).length > 0 && (
                  <div className="bg-white p-8 md:p-10 border border-black/5 space-y-6">
                    <h2 className="text-xl font-bold border-b border-black/10 pb-4">Additional Information</h2>
                    {(content?.checkoutFields ?? []).map((field) => (
                      <FormItem key={field.id}>
                        <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">{field.label}{field.required ? " *" : " (Optional)"}</FormLabel>
                        <FormControl>
                          <Input {...form.register(`customFields.${field.id}`)} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                        </FormControl>
                        <FormMessage>{form.formState.errors.customFields?.[field.id]?.message}</FormMessage>
                      </FormItem>
                    ))}
                  </div>
                )}

                <div className="bg-white p-8 md:p-10 border border-black/5 space-y-8">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Contact Information</h2>
                  <div className="grid md:grid-cols-2 gap-6">
                    <FormField control={form.control} name="customerName" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Full Name</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="customerEmail" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Email Address</FormLabel>
                        <FormControl>
                          <Input type="email" {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="customerPhone" render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Student ID (s100)</FormLabel>
                        <FormControl>
                          <Input type="tel" {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </div>

                <div className="bg-white p-8 md:p-10 border border-black/5 space-y-8">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Shipping Address</h2>

                  <div className="space-y-4">
                    {hasDefaultAddress ? (
                      <FormField control={form.control} name="shippingAddressId" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Saved addresses</FormLabel>
                          <FormControl>
                            <div className="space-y-4">
                              {shippingAddresses.map((address) => {
                                const isSelected = useDefaultAddress && field.value === address.id;
                                return (
                                  <button
                                    key={address.id}
                                    type="button"
                                    onClick={() => {
                                      field.onChange(address.id);
                                      form.setValue("useDefaultAddress", true, { shouldValidate: true });
                                    }}
                                    aria-pressed={isSelected}
                                    className={`w-full text-left p-6 flex items-start gap-4 transition-colors ${
                                      isSelected
                                        ? "border-2 border-black bg-[#FAF7F2]/50"
                                        : "border border-black/15 hover:border-black/40 bg-white"
                                    }`}
                                  >
                                    <div className={`mt-1 w-5 h-5 rounded-full border-4 flex items-center justify-center shrink-0 ${isSelected ? "border-black" : "border-black/30"}`}>
                                      {isSelected && <div className="w-2 h-2 bg-black rounded-full"></div>}
                                    </div>
                                    <div className="flex-1">
                                      <h3 className="font-bold text-lg mb-1">{address.label}</h3>
                                      <p className="text-black/60 font-medium leading-relaxed text-sm">
                                        {address.address}, {address.city}, {address.postalCode}, {address.country}
                                      </p>
                                      <p className="text-black/50 font-medium leading-relaxed text-sm mt-1">
                                        {formatPrice(address.shippingFeeCents)} convenience fee
                                      </p>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    ) : (
                      <p className="border border-black/15 p-6 text-sm italic text-black/50">
                        No saved shipping addresses have been configured yet.
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={() => form.setValue("useDefaultAddress", false, { shouldValidate: true })}
                      className={`w-full text-left p-6 flex items-start gap-4 transition-colors ${
                        !useDefaultAddress
                          ? "border-2 border-black bg-[#FAF7F2]/50"
                          : "border border-black/15 hover:border-black/40 bg-white"
                      }`}
                    >
                      <div className={`mt-1 w-5 h-5 rounded-full border-4 flex items-center justify-center shrink-0 ${!useDefaultAddress ? "border-black" : "border-black/30"}`}>
                        {!useDefaultAddress && <div className="w-2 h-2 bg-black rounded-full"></div>}
                      </div>
                      <div className="flex-1">
                        <h3 className="font-bold text-lg mb-1">Custom address</h3>
                        <p className="text-black/60 font-medium leading-relaxed text-sm">
                          Ship to a different address you enter yourself. Includes a {formatPrice(CUSTOM_ADDRESS_SHIPPING_FEE_CENTS)} processing and delivery fee.
                        </p>
                      </div>
                    </button>
                  </div>

                  {useDefaultAddress ? (
                    <div className="space-y-6 pt-2">
                      <FormField control={form.control} name="classroom" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Classroom Number</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="e.g. Room 204" className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  ) : (
                    <div className="space-y-6 pt-2">
                      <FormField control={form.control} name="shippingAddress" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Street Address</FormLabel>
                          <FormControl>
                            <Input {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <div className="grid md:grid-cols-2 gap-6">
                        <FormField control={form.control} name="city" render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">City</FormLabel>
                            <FormControl>
                              <Input {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={form.control} name="postalCode" render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Postal Code</FormLabel>
                            <FormControl>
                              <Input {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </div>
                      <FormField control={form.control} name="country" render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Country</FormLabel>
                          <FormControl>
                            <Input {...field} className="h-12 bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  )}
                </div>

                <div className="bg-white p-8 md:p-10 border border-black/5 space-y-8">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Payment Method</h2>
                  <div className="border-2 border-black p-6 flex items-start gap-4 bg-[#FAF7F2]/50">
                    <div className="mt-1 w-5 h-5 rounded-full border-4 border-black flex items-center justify-center shrink-0">
                      <div className="w-2 h-2 bg-black rounded-full"></div>
                    </div>
                    <div>
                      <h3 className="font-bold text-lg mb-1">Cash on Delivery</h3>
                      <p className="text-black/60 font-medium leading-relaxed">You will pay in cash when your order is delivered. No credit card required now.</p>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-8 md:p-10 border border-black/5 space-y-8">
                  <FormField control={form.control} name="notes" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs uppercase tracking-widest text-black/50 font-bold">Order Notes (Optional)</FormLabel>
                      <FormControl>
                        <Textarea {...field} className="min-h-[100px] bg-transparent border-black/20 rounded-none focus-visible:ring-0 focus-visible:border-black shadow-none resize-none" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <Button 
                  type="submit" 
                  disabled={createOrder.isPending}
                  className="w-full h-16 rounded-none bg-black hover:bg-[var(--theme-accent)] text-white text-[14px] uppercase tracking-widest font-bold transition-colors"
                >
                  {createOrder.isPending ? "Processing..." : "Place Order"}
                </Button>

              </form>
            </Form>
          </div>

          {/* Order Summary */}
          <div className="w-full lg:w-[40%] bg-white p-8 md:p-10 border border-black/5 sticky top-12">
            <h2 className="text-xl font-bold mb-8 pb-4 border-b border-black/10">Order Summary</h2>
            
            <div className="space-y-6 mb-8 max-h-[400px] overflow-y-auto pr-2">
              {enrichedItems.map((item) => {
                const p = item.product;
                if (!p) return null;
                return (
                  <div key={item.productId} className="flex gap-4 items-center">
                    <div className="w-16 h-20 bg-[#FAF7F2] p-1 shrink-0 flex items-center justify-center relative">
                      <img src={p.imageUrl || "https://placehold.co/100x150?text=Img"} alt={p.name} className="w-full h-full object-contain mix-blend-multiply" />
                      <span className="absolute -top-2 -right-2 w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-[10px] font-bold">
                        {item.quantity}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate mb-1">{p.name}</p>
                      <p className="text-black/50 text-xs font-medium">{formatPrice(p.priceCents, p.currency)}</p>
                    </div>
                    <div className="font-bold text-sm shrink-0">
                      {formatPrice(p.priceCents * item.quantity, p.currency)}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-4 mb-8 pt-6 border-t border-black/10 font-medium text-sm">
              {user && (
                <div className="border-b border-black/10 pb-6 mb-2">
                  <h3 className="font-bold text-base">Use Your AFEON Pages</h3>
                  <p className="text-black/60 mt-1">Available Pages: {loyaltyBalance.toLocaleString()}</p>
                  <div className="flex gap-2 mt-4">
                    <Input
                      type="number"
                      min={1000}
                      step={1000}
                      value={pointsToRedeem}
                      onChange={(event) => setPointsToRedeem(event.target.value)}
                      placeholder="1,000"
                      className="h-10 rounded-none"
                    />
                    <Button type="button" onClick={redeemPoints} className="h-10 rounded-none bg-[#72C5C1] hover:bg-[#5CB2AE] text-white">
                      Redeem
                    </Button>
                  </div>
                  <p className="text-xs text-black/50 mt-2">1,000 Pages = $10 off your next purchase.</p>
                </div>
              )}
              <div className="border-b border-black/10 pb-6 mb-2">
                <h3 className="font-bold text-base">Promo code</h3>
                <div className="flex gap-2 mt-4">
                  <Input
                    value={promoInput}
                    onChange={(event) => {
                      setPromoInput(event.target.value.toUpperCase());
                      if (appliedPromoCode) { setAppliedPromoCode(""); setPromoDiscountCents(0); }
                    }}
                    placeholder="Enter code"
                    aria-label="Promo code"
                    className="h-10 rounded-none font-mono uppercase"
                  />
                  {appliedPromoCode ? (
                    <Button type="button" variant="outline" onClick={() => { setAppliedPromoCode(""); setPromoDiscountCents(0); setPromoInput(""); }} className="h-10 rounded-none border-black/25 text-xs font-bold uppercase">Remove</Button>
                  ) : (
                    <Button type="button" onClick={() => void applyPromoCode()} disabled={promoBusy || !promoInput.trim()} className="h-10 rounded-none bg-black text-xs font-bold uppercase text-white">{promoBusy ? "Checking" : "Apply"}</Button>
                  )}
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-black/60">Subtotal</span>
                <span>{formatPrice(subtotalCents)}</span>
              </div>
              {redeemedPoints > 0 && (
                <div className="flex justify-between">
                  <span className="text-black/60">Rewards discount</span>
                  <span>-{formatPrice(loyaltyDiscountCents)}</span>
                </div>
              )}
              {appliedPromoCode && (
                <div className="flex justify-between text-emerald-800">
                  <span>Promo discount ({appliedPromoCode})</span>
                  <span>-{formatPrice(promoDiscountCents)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-black/60">{useDefaultAddress ? "Convenience Fee" : "Processing & delivery"}</span>
                <span>{shippingCents > 0 ? formatPrice(shippingCents) : "Free"}</span>
              </div>
              <div className="flex justify-between text-[#9A5B13]">
                <span>Pages earned</span>
                <span className="font-bold">+{estimatedPoints.toLocaleString()}</span>
              </div>
            </div>

            <div className="pt-6 border-t border-black/10 flex justify-between items-end">
              <div>
                <span className="block text-xs uppercase tracking-widest text-black/50 font-bold mb-1">Total to pay</span>
                <span className="text-sm font-medium text-black/40">Cash on delivery</span>
              </div>
              <span className="text-3xl font-bold">{formatPrice(totalCents)}</span>
            </div>
          </div>

        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

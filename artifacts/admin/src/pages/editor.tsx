import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { formatPrice } from "@/lib/format";
import { renderEmailPreview } from "@/lib/email-preview";
import Marketing from "@/pages/marketing";
import Users from "@/pages/users";
import { ArrowDown, ArrowUp, Edit2, Trash2, Send, Download } from "lucide-react";
import * as XLSX from "xlsx";
import xlogo from "@assets/logo_web.png";
import {
  useGetContent,
  useUpdateContent,
  useListProducts,
  useCreateProduct,
  useUpdateProduct,
  useDeleteProduct,
  useListOrders,
  useUpdateOrderStatus,
  useDeleteOrder,
  useSendTestEmail,
  getGetContentQueryKey,
  getListProductsQueryKey,
  getListOrdersQueryKey,
  getGetOrdersSummaryQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import type { UpdateOrderStatusStatus } from "@workspace/api-client-react";
import type { Order } from "@workspace/api-client-react";

const ORDER_STATUSES: UpdateOrderStatusStatus[] = [
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  confirmed: "bg-blue-100 text-blue-800 border-blue-200",
  shipped: "bg-indigo-100 text-indigo-800 border-indigo-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
};

type OrderEditValues = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  city: string;
  postalCode: string;
  country: string;
  classroom: string;
  notes: string;
  shipping: string;
  discount: string;
};

function currencyInputToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

const contentSchema = z.object({
  checkoutFields: z.array(z.object({ id: z.string(), label: z.string().min(1), required: z.boolean() })).default([]),
  shippingAddresses: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1, "Address label is required"),
    address: z.string().min(1, "Street address is required"),
    city: z.string().min(1, "City is required"),
    postalCode: z.string().min(1, "Postal code is required"),
    country: z.string().min(1, "Country is required"),
    shippingFeeCents: z.coerce.number().int().min(0, "Fee cannot be negative"),
  })).default([]),
  loyaltyPagesPerDollar: z.coerce.number().int().min(0, "Pages per dollar must be zero or greater").max(1000000),
  brandName: z.string().min(1),
  navHomeLabel: z.string().min(1),
  heroTitle: z.string().min(1),
  heroSubtitle: z.string().min(1),
  ctaLabel: z.string().min(1),
  ctaUrl: z.string().min(1),
  coverImageUrl: z.string().url(),
  aboutHeading: z.string().min(1),
  aboutBody: z.string().min(1),
  faqs: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).default([]),
  authorsLine: z.string().min(1),
  illustratorLine: z.string().min(1),
  footerNote: z.string().min(1),
  accentColor: z.string().min(1),
  defaultShippingLabel: z.string(),
  defaultShippingAddress: z.string(),
  defaultShippingCity: z.string(),
  defaultShippingPostalCode: z.string(),
  defaultShippingCountry: z.string(),
  ordersEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  emailFromName: z.string().min(1, "From name is required"),
  emailFromAddress: z.string().email("Must be a valid email address"),
  emailReplyTo: z.string().refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Must be a valid email or empty"),
  emailSubject: z.string().min(1, "Subject is required"),
  emailHeading: z.string().min(1, "Heading is required"),
  emailIntro: z.string().min(1, "Intro is required"),
  emailButtonLabel: z.string().min(1, "Button label is required"),
  emailFooter: z.string(),
  emailAccentColor: z.string().min(1),
  blogTitle: z.string().min(1),
  blogSubtitle: z.string().min(1),
  blogDate: z.string().min(1),
  blogHeroImageUrl: z.string(),
  blogBody: z.string().min(1),
});

const productSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().min(1, "Description is required"),
  priceDollars: z.coerce.number().min(0.01, "Price must be > 0"),
  currency: z.string().min(3).max(3),
  imageUrl: z.string().url("Must be a valid URL"),
  stock: z.coerce.number().int().min(0, "Stock cannot be negative"),
  active: z.boolean(),
  showInShop: z.boolean(),
});

export default function Editor() {
  const [devTesting, setDevTesting] = useState(false);
  const [devTestExpiresAt, setDevTestExpiresAt] = useState<Date | null>(null);
  const [devTestCountdown, setDevTestCountdown] = useState("");
  const [devTestLoading, setDevTestLoading] = useState(false);
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);

  const fetchMaintenanceStatus = async () => {
    try {
      const res = await fetch("/api/maintenance/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { enabled?: boolean };
      setMaintenanceEnabled(data.enabled === true);
    } catch { /* ignore */ }
  };

  const toggleMaintenance = async () => {
    setMaintenanceLoading(true);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !maintenanceEnabled }),
      });
      const data = await res.json() as { enabled?: boolean; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Unable to change maintenance mode"); return; }
      setMaintenanceEnabled(data.enabled === true);
      toast.success(data.enabled ? "Maintenance mode is on" : "Maintenance mode is off");
    } catch { toast.error("Connection error"); }
    finally { setMaintenanceLoading(false); }
  };

  useEffect(() => { void fetchMaintenanceStatus(); }, []);

  const fetchDevTestStatus = async () => {
    try {
      const res = await fetch("/api/dev-testing/status");
      const data = await res.json() as { active: boolean; expiresAt: string | null };
      setDevTesting(data.active);
      setDevTestExpiresAt(data.active && data.expiresAt ? new Date(data.expiresAt) : null);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    void fetchDevTestStatus();
    const poll = setInterval(() => void fetchDevTestStatus(), 30_000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!devTestExpiresAt) { setDevTestCountdown(""); return; }
    const tick = () => {
      const remaining = devTestExpiresAt.getTime() - Date.now();
      if (remaining <= 0) {
        setDevTesting(false);
        setDevTestExpiresAt(null);
        setDevTestCountdown("");
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        return;
      }
      const m = Math.floor(remaining / 60_000);
      const s = Math.floor((remaining % 60_000) / 1000);
      setDevTestCountdown(`${m}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [devTestExpiresAt]);

  const startDevTesting = async () => {
    if (!confirm("Start a 10-minute dev testing session?\n\nAll changes to orders and product stock will be automatically reverted when the session ends or you click Stop.")) return;
    setDevTestLoading(true);
    try {
      const res = await fetch("/api/dev-testing/start", { method: "POST" });
      const data = await res.json() as { active?: boolean; expiresAt?: string; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      setDevTesting(true);
      setDevTestExpiresAt(data.expiresAt ? new Date(data.expiresAt) : null);
      toast.success("Dev testing mode active — changes will be reverted on stop");
    } catch { toast.error("Connection error"); }
    finally { setDevTestLoading(false); }
  };

  const stopDevTesting = async () => {
    if (!confirm("Stop dev testing and revert all changes made during this session?")) return;
    setDevTestLoading(true);
    try {
      const res = await fetch("/api/dev-testing/stop", { method: "POST" });
      const data = await res.json() as { restored?: boolean; orderCount?: number; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Failed to stop"); return; }
      setDevTesting(false);
      setDevTestExpiresAt(null);
      toast.success(`Testing session ended — ${data.orderCount ?? 0} orders restored`);
      queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOrdersSummaryQueryKey() });
    } catch { toast.error("Connection error"); }
    finally { setDevTestLoading(false); }
  };

  const [activeTab, setActiveTab] = useState<"content" | "products" | "orders" | "email" | "marketing" | "users">("content");
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [isReorderingProducts, setIsReorderingProducts] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState<string>("");
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [orderEditValues, setOrderEditValues] = useState<OrderEditValues | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const { data: content, isLoading: contentLoading } = useGetContent();
  const { data: products } = useListProducts();
  const { data: orders } = useListOrders();

  const updateContent = useUpdateContent();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const updateOrderStatus = useUpdateOrderStatus();
  const deleteOrder = useDeleteOrder();
  const sendTestEmail = useSendTestEmail();

  const handleStatusChange = (orderId: number, status: UpdateOrderStatusStatus) => {
    const estimatedDeliveryDate = status === "shipped"
      ? window.prompt("When is this order expected to be delivered? Enter a date (YYYY-MM-DD):", "")?.trim()
      : undefined;
    if (status === "shipped" && (!estimatedDeliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(estimatedDeliveryDate))) {
      toast.error("A delivery date in YYYY-MM-DD format is required");
      return;
    }
    updateOrderStatus.mutate(
      { id: orderId, data: { status, ...(estimatedDeliveryDate ? { estimatedDeliveryDate } : {}) } },
      {
        onSuccess: () => {
          toast.success(`Order #${orderId} marked as ${status}`);
          queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOrdersSummaryQueryKey() });
        },
        onError: () => toast.error("Failed to update status"),
      }
    );
  };

  const exportOrdersToExcel = () => {
    if (!orders?.length) { toast.error("No orders to export"); return; }

    const fmt = (cents: number) => (cents / 100).toFixed(2);
    const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

    const ordersSheet = orders.map((o) => ({
      "Order #": o.id,
      "Date": fmtDate(o.createdAt),
      "Status": o.status,
      "Customer Name": o.customerName,
      "Email": o.customerEmail,
      "Student ID": o.customerPhone ?? "",
      "Classroom": o.classroom ?? "",
      "Shipping Address": o.shippingAddress,
      "City": o.city,
      "Postal Code": o.postalCode,
      "Country": o.country,
      "Use Default Address": o.useDefaultAddress ? "Yes" : "No",
      "Notes": o.notes ?? "",
      "Payment Method": o.paymentMethod,
      "Order Type": o.orderType,
      "Payment Status": o.paymentStatus,
      "Subtotal ($)": parseFloat(fmt(o.subtotalCents)),
      "Shipping ($)": parseFloat(fmt(o.shippingCents)),
      "Total ($)": parseFloat(fmt(o.totalCents)),
      "Currency": o.currency,
      "UTM Source": o.utmSource ?? "",
      "UTM Medium": o.utmMedium ?? "",
      "UTM Campaign": o.utmCampaign ?? "",
      "Landing Page": o.landingPage ?? "",
    }));

    const itemsSheet = orders.flatMap((o) =>
      o.items.map((it) => ({
        "Order #": o.id,
        "Customer": o.customerName,
        "Product Name": it.productName,
        "Quantity": it.quantity,
        "Unit Price ($)": parseFloat(fmt(it.unitPriceCents)),
        "Line Total ($)": parseFloat(fmt(it.unitPriceCents * it.quantity)),
      }))
    );

    const wb = XLSX.utils.book_new();

    const wsOrders = XLSX.utils.json_to_sheet(ordersSheet);
    wsOrders["!cols"] = [
      {wch:10},{wch:22},{wch:12},{wch:22},{wch:28},{wch:14},{wch:12},
      {wch:28},{wch:16},{wch:12},{wch:8},{wch:20},{wch:20},{wch:18},
      {wch:12},{wch:12},{wch:12},{wch:8},{wch:14},{wch:14},{wch:16},{wch:40},
    ];

    const wsItems = XLSX.utils.json_to_sheet(itemsSheet);
    wsItems["!cols"] = [{wch:10},{wch:22},{wch:40},{wch:10},{wch:14},{wch:14}];

    XLSX.utils.book_append_sheet(wb, wsOrders, "Orders");
    XLSX.utils.book_append_sheet(wb, wsItems, "Order Items");

    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `afeon-orders-${date}.xlsx`);
    toast.success(`Exported ${orders.length} orders`);
  };

  const handleDeleteOrder = (orderId: number) => {
    if (!confirm(`Permanently delete order #${orderId}? This cannot be undone.`)) return;
    deleteOrder.mutate(
      { id: orderId },
      {
        onSuccess: () => {
          toast.success(`Order #${orderId} deleted`);
          queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOrdersSummaryQueryKey() });
        },
        onError: () => toast.error("Failed to delete order"),
      }
    );
  };

  const openOrderEditor = (order: Order) => {
    setEditingOrder(order);
    setOrderEditValues({
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      shippingAddress: order.shippingAddress,
      city: order.city,
      postalCode: order.postalCode,
      country: order.country,
      classroom: order.classroom ?? "",
      notes: order.notes ?? "",
      shipping: (order.shippingCents / 100).toFixed(2),
      discount: ((order.discountCents ?? 0) / 100).toFixed(2),
    });
  };

  const saveOrderEdits = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingOrder || !orderEditValues) return;
    const shippingCents = currencyInputToCents(orderEditValues.shipping);
    const discountCents = currencyInputToCents(orderEditValues.discount);
    if (shippingCents === null || discountCents === null) {
      toast.error("Enter valid shipping and discount amounts with up to two decimal places.");
      return;
    }
    if (discountCents > editingOrder.subtotalCents) {
      toast.error("Discount cannot exceed the order subtotal.");
      return;
    }
    setSavingOrder(true);
    try {
      const response = await fetch(`/api/orders/${editingOrder.id}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: orderEditValues.customerName,
          customerEmail: orderEditValues.customerEmail,
          customerPhone: orderEditValues.customerPhone,
          shippingAddress: orderEditValues.shippingAddress,
          city: orderEditValues.city,
          postalCode: orderEditValues.postalCode,
          country: orderEditValues.country,
          classroom: orderEditValues.classroom,
          notes: orderEditValues.notes,
          shippingCents,
          discountCents,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Unable to update order (${response.status})`);
      toast.success(`Order #${editingOrder.id} updated`);
      setEditingOrder(null);
      setOrderEditValues(null);
      queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetOrdersSummaryQueryKey() });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update order");
    } finally {
      setSavingOrder(false);
    }
  };

  const queryClient = useQueryClient();

  const contentForm = useForm<z.infer<typeof contentSchema>>({
    resolver: zodResolver(contentSchema),
    defaultValues: {
      brandName: "", navHomeLabel: "", heroTitle: "", heroSubtitle: "",
      ctaLabel: "", ctaUrl: "", coverImageUrl: "", aboutHeading: "",
      aboutBody: "", authorsLine: "", illustratorLine: "", footerNote: "", accentColor: "#000",
      faqs: [],
      defaultShippingLabel: "",
      defaultShippingAddress: "",
      defaultShippingCity: "",
      defaultShippingPostalCode: "",
      defaultShippingCountry: "",
      shippingAddresses: [],
      loyaltyPagesPerDollar: 50,
      ordersEnabled: true,
      emailEnabled: false,
      emailFromName: "AFEON Books",
      emailFromAddress: "onboarding@resend.dev",
      emailReplyTo: "",
      emailSubject: "Your order #{{orderId}} is confirmed!",
      emailHeading: "Thank you for your order!",
      emailIntro: "",
      emailButtonLabel: "View your order",
      emailFooter: "",
      emailAccentColor: "#7DD3EA",
      blogTitle: "",
      blogSubtitle: "",
      blogDate: "",
      blogHeroImageUrl: "",
      blogBody: "",
      checkoutFields: [],
    },
  });

  const initialized = useRef(false);
  useEffect(() => {
    if (content && !initialized.current) {
      contentForm.reset(content);
      initialized.current = true;
    }
  }, [content, contentForm]);

  const onContentSubmit = (values: z.infer<typeof contentSchema>) => {
    updateContent.mutate({ data: values }, {
      onSuccess: (data) => {
        toast.success("Site content saved!");
        queryClient.setQueryData(getGetContentQueryKey(), data);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to save site content.")
    });
  };

  const productForm = useForm<z.infer<typeof productSchema>>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "", description: "", priceDollars: 10.00, currency: "USD",
      imageUrl: "", stock: 100, active: true, showInShop: true
    }
  });

  const onProductSubmit = (values: z.infer<typeof productSchema>) => {
    const payload = {
      name: values.name,
      description: values.description,
      priceCents: Math.round(values.priceDollars * 100),
      currency: values.currency,
      imageUrl: values.imageUrl,
      stock: values.stock,
      active: values.active,
      showInShop: values.showInShop,
    };

    if (editingProductId) {
      updateProduct.mutate({ id: editingProductId, data: payload }, {
        onSuccess: () => {
          toast.success("Product updated!");
          queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
          setEditingProductId(null);
          productForm.reset();
        },
        onError: () => toast.error("Failed to update product.")
      });
    } else {
      createProduct.mutate({ data: payload }, {
        onSuccess: () => {
          toast.success("Product added!");
          queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
          productForm.reset();
        },
        onError: () => toast.error("Failed to add product.")
      });
    }
  };

  const handleEditProduct = (product: any) => {
    setEditingProductId(product.id);
    productForm.reset({
      name: product.name,
      description: product.description,
      priceDollars: product.priceCents / 100,
      currency: product.currency,
      imageUrl: product.imageUrl,
      stock: product.stock,
      active: product.active,
      showInShop: product.showInShop,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteProduct = (id: number) => {
    if (confirm("Are you sure you want to delete this product?")) {
      deleteProduct.mutate({ id }, {
        onSuccess: () => {
          toast.success("Product deleted.");
          queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
        },
        onError: () => toast.error("Failed to delete product.")
      });
    }
  };

  const handleMoveProduct = async (index: number, direction: -1 | 1) => {
    const orderedProducts = [...(products ?? [])];
    const destination = index + direction;
    if (isReorderingProducts || destination < 0 || destination >= orderedProducts.length) return;

    [orderedProducts[index], orderedProducts[destination]] = [
      orderedProducts[destination]!,
      orderedProducts[index]!,
    ];

    setIsReorderingProducts(true);
    try {
      await customFetch<{ success: boolean }>("/api/products/reorder", {
        method: "PUT",
        body: JSON.stringify({ productIds: orderedProducts.map((product) => product.id) }),
      });
      await queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() });
      toast.success("Product order updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update product order.");
    } finally {
      setIsReorderingProducts(false);
    }
  };

  const coverImageUrl = contentForm.watch("coverImageUrl");

  const emailWatch = contentForm.watch([
    "brandName",
    "footerNote",
    "emailFromName",
    "emailSubject",
    "emailHeading",
    "emailIntro",
    "emailButtonLabel",
    "emailFooter",
    "emailAccentColor",
    "defaultShippingLabel",
    "defaultShippingAddress",
    "defaultShippingCity",
    "defaultShippingPostalCode",
    "defaultShippingCountry",
  ]);

  const emailPreviewHtml = useMemo(() => {
    const [
      brandName, footerNote, emailFromName, emailSubject, emailHeading,
      emailIntro, emailButtonLabel, emailFooter, emailAccentColor,
      defaultShippingLabel, defaultShippingAddress, defaultShippingCity,
      defaultShippingPostalCode, defaultShippingCountry,
    ] = emailWatch;
    return renderEmailPreview({
      brandName: brandName || "",
      footerNote: footerNote || "",
      emailFromName: emailFromName || "",
      emailSubject: emailSubject || "",
      emailHeading: emailHeading || "",
      emailIntro: emailIntro || "",
      emailButtonLabel: emailButtonLabel || "",
      emailFooter: emailFooter || "",
      emailAccentColor: emailAccentColor || "#7DD3EA",
      defaultShippingLabel: defaultShippingLabel || "",
      defaultShippingAddress: defaultShippingAddress || "",
      defaultShippingCity: defaultShippingCity || "",
      defaultShippingPostalCode: defaultShippingPostalCode || "",
      defaultShippingCountry: defaultShippingCountry || "",
    });
  }, [emailWatch]);

  const handleSendTestEmail = () => {
    const to = testEmailTo.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    contentForm.handleSubmit((values) => {
      updateContent.mutate({ data: values }, {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetContentQueryKey(), data);
          sendTestEmail.mutate({ data: { to } }, {
            onSuccess: (res) => {
              if (res.ok) {
                toast.success(res.message || `Test email sent to ${to}`);
              } else {
                toast.error(res.message || "Failed to send test email.");
              }
            },
            onError: () => toast.error("Failed to send test email."),
          });
        },
        onError: () => toast.error("Couldn't save template before sending test."),
      });
    })();
  };

  if (contentLoading) {
    return <div className="min-h-screen flex items-center justify-center"><p>Loading...</p></div>;
  }

  return (
    <div className="min-h-screen bg-[#FAF7F2] pb-20 font-sans allow-select">
      <header className="bg-white border-b border-black/10 sticky top-0 z-50 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-8">
            <a href="/" aria-label="Home" className="w-9 h-9 flex items-center justify-center hover:opacity-80 transition-opacity">
              <img src={xlogo} alt="" className="w-full h-full object-contain" draggable={false} />
            </a>
            <h1 className="font-bold text-xl tracking-tight">Admin Dashboard</h1>
          </div>
          <div className="flex gap-4 items-center">
            <a
              href="/"
              className="inline-flex items-center justify-center min-h-9 px-4 py-2 rounded-md text-sm font-medium border border-black/20 hover:bg-black/5 transition-colors"
            >
              View Site
            </a>
            <button
              type="button"
              onClick={() => void toggleMaintenance()}
              disabled={maintenanceLoading}
              className="inline-flex items-center justify-center min-h-9 px-4 py-2 rounded-md text-sm font-medium border border-amber-400 text-amber-800 hover:bg-amber-50 transition-colors disabled:opacity-50"
            >
              {maintenanceLoading ? "Updating..." : maintenanceEnabled ? "Turn Off Maintenance" : "Turn On Maintenance"}
            </button>
            {devTesting ? (
              <Button
                type="button"
                onClick={stopDevTesting}
                disabled={devTestLoading}
                className="rounded-none bg-amber-500 hover:bg-amber-600 text-white uppercase tracking-widest text-xs font-bold gap-2"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                {devTestCountdown ? `Stop Testing (${devTestCountdown})` : "Stop Testing"}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={startDevTesting}
                disabled={devTestLoading}
                className="rounded-none bg-amber-500 hover:bg-amber-600 text-white uppercase tracking-widest text-xs font-bold gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                Dev Testing
              </Button>
            )}
            <Button
              type="button"
              onClick={() => {
                const current = contentForm.getValues();
                const newValue = !current.ordersEnabled;
                contentForm.setValue("ordersEnabled", newValue);
                updateContent.mutate(
                  { data: { ...current, ordersEnabled: newValue } },
                  {
                    onSuccess: () => toast.success(newValue ? "Now accepting orders" : "Orders paused — store is closed"),
                    onError: () => {
                      contentForm.setValue("ordersEnabled", !newValue);
                      toast.error("Failed to update");
                    },
                  }
                );
              }}
              disabled={updateContent.isPending}
              className={`rounded-none uppercase tracking-widest text-xs font-bold transition-colors ${
                contentForm.watch("ordersEnabled")
                  ? "bg-emerald-600 hover:bg-red-600 text-white"
                  : "bg-red-600 hover:bg-emerald-600 text-white"
              }`}
            >
              {contentForm.watch("ordersEnabled") ? "Accepting Orders" : "Orders Paused"}
            </Button>
            {(activeTab === "content" || activeTab === "email") && (
              <Button
                onClick={() => contentForm.handleSubmit(
                  onContentSubmit,
                  (errors) => {
                    const invalidFields = Object.keys(errors);
                    toast.error(
                      invalidFields.length
                        ? `Please fix these fields before saving: ${invalidFields.join(", ")}`
                        : "Please check the content form and try again.",
                    );
                  },
                )()}
                disabled={updateContent.isPending}
                className="rounded-none bg-black text-white hover:bg-black/80 uppercase tracking-widest text-xs font-bold"
              >
                {updateContent.isPending ? "Saving..." : activeTab === "email" ? "Save Email Template" : "Save Content"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex gap-8 mb-12 border-b border-black/10">
          {(["content", "products", "email", "orders", "marketing", "users"] as const).map((tab) => (
            <button
              key={tab}
              className={`pb-4 font-bold text-sm tracking-widest uppercase border-b-2 transition-colors ${activeTab === tab ? "border-black text-black" : "border-transparent text-black/40 hover:text-black/80"}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "content" ? "Site Content" : tab === "orders" ? "Recent Orders" : tab === "marketing" ? "Banners & Promos" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === "content" && (
          <Form {...contentForm}>
            <form className="grid grid-cols-1 md:grid-cols-3 gap-12">
              <div className="md:col-span-2 space-y-12">
                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">General Settings</h2>
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={contentForm.control} name="brandName" render={({ field }) => (
                      <FormItem><FormLabel>Brand Name</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                    <FormField control={contentForm.control} name="accentColor" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Accent Color (Hex)</FormLabel>
                        <div className="flex gap-2">
                          <FormControl><Input type="color" className="w-12 h-10 p-1 rounded-none cursor-pointer" {...field} /></FormControl>
                          <FormControl><Input {...field} className="rounded-none font-mono" /></FormControl>
                        </div>
                      </FormItem>
                    )} />
                  </div>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-4">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Loyalty Pages</h2>
                  <p className="text-sm text-black/50">Set how many Pages customers earn for each whole dollar spent on a delivered order. Set to 0 to pause earning.</p>
                  <FormField control={contentForm.control} name="loyaltyPagesPerDollar" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pages earned per dollar</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="0"
                          max="1000000"
                          step="1"
                          {...field}
                          className="max-w-xs rounded-none"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Hero Section</h2>
                  <FormField control={contentForm.control} name="heroTitle" render={({ field }) => (
                    <FormItem><FormLabel>Hero Title</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="heroSubtitle" render={({ field }) => (
                    <FormItem><FormLabel>Hero Subtitle</FormLabel><FormControl><Textarea {...field} className="rounded-none min-h-[100px]" /></FormControl></FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={contentForm.control} name="ctaLabel" render={({ field }) => (
                      <FormItem><FormLabel>CTA Label</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                    <FormField control={contentForm.control} name="ctaUrl" render={({ field }) => (
                      <FormItem><FormLabel>CTA URL</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                  </div>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Checkout Shipping Addresses</h2>
                  <p className="text-sm text-black/50 -mt-2">Customers can choose any address listed here or enter a custom address at checkout.</p>
                  {(contentForm.watch("shippingAddresses") ?? []).map((address, index) => (
                    <div key={address.id} className="space-y-4 border border-black/10 p-5">
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold">Address {index + 1}</h3>
                        <Button type="button" variant="outline" className="rounded-none" onClick={() => {
                          const next = [...contentForm.getValues("shippingAddresses")];
                          next.splice(index, 1);
                          contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                        }}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                      <Input
                        aria-label={`Address ${index + 1} label`}
                        placeholder="Display label (e.g. School delivery)"
                        value={address.label}
                        onChange={(event) => {
                          const next = [...contentForm.getValues("shippingAddresses")];
                          next[index] = { ...next[index], label: event.target.value };
                          contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                        }}
                        className="rounded-none"
                      />
                      <Input
                        aria-label={`Address ${index + 1} street`}
                        placeholder="Street address"
                        value={address.address}
                        onChange={(event) => {
                          const next = [...contentForm.getValues("shippingAddresses")];
                          next[index] = { ...next[index], address: event.target.value };
                          contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                        }}
                        className="rounded-none"
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          aria-label={`Address ${index + 1} city`}
                          placeholder="City"
                          value={address.city}
                          onChange={(event) => {
                            const next = [...contentForm.getValues("shippingAddresses")];
                            next[index] = { ...next[index], city: event.target.value };
                            contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                          }}
                          className="rounded-none"
                        />
                        <Input
                          aria-label={`Address ${index + 1} postal code`}
                          placeholder="Postal code"
                          value={address.postalCode}
                          onChange={(event) => {
                            const next = [...contentForm.getValues("shippingAddresses")];
                            next[index] = { ...next[index], postalCode: event.target.value };
                            contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                          }}
                          className="rounded-none"
                        />
                      </div>
                      <Input
                        aria-label={`Address ${index + 1} country`}
                        placeholder="Country"
                        value={address.country}
                        onChange={(event) => {
                          const next = [...contentForm.getValues("shippingAddresses")];
                          next[index] = { ...next[index], country: event.target.value };
                          contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                        }}
                        className="rounded-none"
                      />
                      <div>
                        <label htmlFor={`shipping-fee-${address.id}`} className="mb-2 block text-sm font-medium">
                          Shipping fee ($)
                        </label>
                        <Input
                          id={`shipping-fee-${address.id}`}
                          aria-label={`Address ${index + 1} shipping fee in dollars`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={(address.shippingFeeCents / 100).toFixed(2)}
                          onChange={(event) => {
                            const fee = Number(event.target.value);
                            const next = [...contentForm.getValues("shippingAddresses")];
                            next[index] = {
                              ...next[index],
                              shippingFeeCents: Number.isFinite(fee) ? Math.round(fee * 100) : 0,
                            };
                            contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                          }}
                          className="rounded-none"
                        />
                      </div>
                    </div>
                  ))}
                  <Button type="button" variant="outline" className="rounded-none" onClick={() => {
                    const next = [...contentForm.getValues("shippingAddresses"), {
                      id: crypto.randomUUID(),
                      label: "",
                      address: "",
                      city: "",
                      postalCode: "",
                      country: "",
                      shippingFeeCents: 0,
                    }];
                    contentForm.setValue("shippingAddresses", next, { shouldDirty: true, shouldValidate: true });
                  }}>
                    Add shipping address
                  </Button>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">About Section</h2>
                  <FormField control={contentForm.control} name="aboutHeading" render={({ field }) => (
                    <FormItem><FormLabel>Heading</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="aboutBody" render={({ field }) => (
                    <FormItem><FormLabel>Body Text</FormLabel><FormControl><Textarea className="min-h-[150px] rounded-none" {...field} /></FormControl></FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={contentForm.control} name="authorsLine" render={({ field }) => (
                      <FormItem><FormLabel>Authors</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                    <FormField control={contentForm.control} name="illustratorLine" render={({ field }) => (
                      <FormItem><FormLabel>Illustrator</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                  </div>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <div>
                    <h2 className="text-xl font-bold border-b border-black/10 pb-4">Frequently Asked Questions</h2>
                    <p className="mt-3 text-sm text-black/50">These questions appear on the home page and the FAQ page.</p>
                  </div>
                  {(contentForm.watch("faqs") ?? []).map((faq, index) => (
                    <div key={index} className="space-y-4 border border-black/10 p-5">
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold">Question {index + 1}</h3>
                        <Button type="button" variant="outline" className="rounded-none" aria-label={`Remove question ${index + 1}`} onClick={() => {
                          const next = [...contentForm.getValues("faqs")];
                          next.splice(index, 1);
                          contentForm.setValue("faqs", next, { shouldDirty: true, shouldValidate: true });
                        }}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <FormField control={contentForm.control} name={`faqs.${index}.question`} render={({ field }) => (
                        <FormItem><FormLabel>Question</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={contentForm.control} name={`faqs.${index}.answer`} render={({ field }) => (
                        <FormItem><FormLabel>Answer</FormLabel><FormControl><Textarea {...field} className="min-h-[100px] rounded-none" /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                  ))}
                  <Button type="button" variant="outline" className="rounded-none" onClick={() => {
                    const next = [...contentForm.getValues("faqs"), { question: "", answer: "" }];
                    contentForm.setValue("faqs", next, { shouldDirty: true, shouldValidate: true });
                  }}>
                    Add question
                  </Button>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <div>
                    <h2 className="text-xl font-bold border-b border-black/10 pb-4">Progress Update</h2>
                    <p className="text-sm text-black/50 mt-3">This content appears on the public progress page. Separate paragraphs with a blank line.</p>
                  </div>
                  <FormField control={contentForm.control} name="blogTitle" render={({ field }) => (
                    <FormItem><FormLabel>Page Title</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="blogSubtitle" render={({ field }) => (
                    <FormItem><FormLabel>Subtitle</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={contentForm.control} name="blogDate" render={({ field }) => (
                      <FormItem><FormLabel>Published Date</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                    )} />
                    <FormField control={contentForm.control} name="blogHeroImageUrl" render={({ field }) => (
                      <FormItem><FormLabel>Hero Image URL</FormLabel><FormControl><Input {...field} className="rounded-none" placeholder="Optional" /></FormControl></FormItem>
                    )} />
                  </div>
                  <FormField control={contentForm.control} name="blogBody" render={({ field }) => (
                    <FormItem><FormLabel>Article Body</FormLabel><FormControl><Textarea {...field} className="min-h-[280px] rounded-none" /></FormControl></FormItem>
                  )} />
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-5">
                  <div>
                    <h2 className="text-xl font-bold">Checkout Fill-in Boxes</h2>
                    <p className="text-sm text-black/50 mt-1">These fields appear for all shoppers at checkout.</p>
                  </div>
                  {(contentForm.watch("checkoutFields") ?? []).map((field, index) => (
                    <div key={field.id} className="flex gap-3 items-end">
                      <div className="flex-1 space-y-2">
                        <label className="text-sm font-medium leading-none">Box label</label>
                        <Input
                          value={field.label}
                          onChange={(event) => {
                            const next = [...(contentForm.getValues("checkoutFields") ?? [])];
                            next[index] = { ...next[index], label: event.target.value };
                            contentForm.setValue("checkoutFields", next);
                          }}
                          className="rounded-none"
                        />
                      </div>
                      <label className="flex items-center gap-2 h-10 text-sm font-medium">
                        <Checkbox
                          checked={field.required}
                          onCheckedChange={(checked) => {
                            const next = [...(contentForm.getValues("checkoutFields") ?? [])];
                            next[index] = { ...next[index], required: checked === true };
                            contentForm.setValue("checkoutFields", next);
                          }}
                        />
                        Required
                      </label>
                      <Button type="button" variant="outline" className="rounded-none" onClick={() => {
                        const next = [...(contentForm.getValues("checkoutFields") ?? [])];
                        next.splice(index, 1);
                        contentForm.setValue("checkoutFields", next);
                      }}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" className="rounded-none" onClick={() => {
                    const next = [...(contentForm.getValues("checkoutFields") ?? []), { id: `field-${Date.now()}`, label: "New field", required: false }];
                    contentForm.setValue("checkoutFields", next);
                  }}>
                    Add fill-in box
                  </Button>
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Navigation &amp; Footer</h2>
                  <FormField control={contentForm.control} name="navHomeLabel" render={({ field }) => (
                    <FormItem><FormLabel>Nav Home Label</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="footerNote" render={({ field }) => (
                    <FormItem><FormLabel>Footer Note</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl></FormItem>
                  )} />
                </div>
              </div>

              <div className="space-y-8">
                <div className="bg-white p-6 border border-black/5 shadow-sm space-y-4">
                  <h3 className="font-bold text-sm uppercase tracking-widest border-b border-black/10 pb-3">Cover Image</h3>
                  <FormField control={contentForm.control} name="coverImageUrl" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Image URL</FormLabel>
                      <FormControl><Input {...field} className="rounded-none text-xs" placeholder="https://..." /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  {coverImageUrl && (
                    <img
                      src={coverImageUrl}
                      alt="Cover preview"
                      className="w-full aspect-[3/4] object-cover border border-black/10"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  )}
                </div>

              </div>
            </form>
          </Form>
        )}

        {activeTab === "products" && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="md:col-span-2">
              <h2 className="text-xl font-bold mb-6">{editingProductId ? "Edit Product" : "Add Product"}</h2>
              <Form {...productForm}>
                <form onSubmit={productForm.handleSubmit(onProductSubmit)} className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={productForm.control} name="name" render={({ field }) => (
                      <FormItem><FormLabel>Product Name</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={productForm.control} name="currency" render={({ field }) => (
                      <FormItem><FormLabel>Currency</FormLabel><FormControl><Input {...field} className="rounded-none font-mono uppercase" maxLength={3} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <FormField control={productForm.control} name="description" render={({ field }) => (
                    <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea {...field} className="rounded-none min-h-[100px]" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={productForm.control} name="priceDollars" render={({ field }) => (
                      <FormItem><FormLabel>Price ($)</FormLabel><FormControl><Input type="number" step="0.01" min="0" {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={productForm.control} name="stock" render={({ field }) => (
                      <FormItem><FormLabel>Stock</FormLabel><FormControl><Input type="number" min="0" {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <FormField control={productForm.control} name="imageUrl" render={({ field }) => (
                    <FormItem><FormLabel>Image URL</FormLabel><FormControl><Input {...field} className="rounded-none" placeholder="https://..." /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={productForm.control} name="active" render={({ field }) => (
                    <FormItem className="flex items-center gap-3">
                      <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      <FormLabel className="mt-0 cursor-pointer">Available (can be ordered and redeemed)</FormLabel>
                    </FormItem>
                  )} />
                  <FormField control={productForm.control} name="showInShop" render={({ field }) => (
                    <FormItem className="flex items-center gap-3">
                      <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                      <FormLabel className="mt-0 cursor-pointer">Show in regular shop</FormLabel>
                    </FormItem>
                  )} />
                  <div className="flex gap-3">
                    <Button type="submit" disabled={createProduct.isPending || updateProduct.isPending} className="rounded-none bg-black text-white hover:bg-black/80 uppercase tracking-widest text-xs font-bold">
                      {createProduct.isPending || updateProduct.isPending ? "Saving..." : editingProductId ? "Update Product" : "Add Product"}
                    </Button>
                    {editingProductId && (
                      <Button type="button" variant="outline" className="rounded-none border-black/20" onClick={() => { setEditingProductId(null); productForm.reset(); }}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
              </Form>
            </div>

            <div>
              <h2 className="text-xl font-bold mb-6">All Products ({products?.length ?? 0})</h2>
              <div className="space-y-3">
                {products?.map((p, index) => (
                  <div key={p.id} className="bg-white border border-black/5 shadow-sm p-4 flex gap-4 items-start">
                    <img src={p.imageUrl} alt={p.name} className="w-16 h-20 object-cover flex-shrink-0 border border-black/10" />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate">{p.name}</p>
                      <p className="text-xs text-black/50 mt-1">{formatPrice(p.priceCents, p.currency)} · {p.stock} in stock</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-sm ${p.active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                          {p.active ? "Available" : "Unavailable"}
                        </span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-sm ${p.showInShop ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                          {p.showInShop ? "In regular shop" : "Hidden from shop"}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => void handleMoveProduct(index, -1)}
                        disabled={isReorderingProducts || index === 0}
                        aria-label={`Move ${p.name} earlier`}
                        title="Move earlier"
                        className="p-1.5 hover:bg-black/5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleMoveProduct(index, 1)}
                        disabled={isReorderingProducts || index === (products?.length ?? 0) - 1}
                        aria-label={`Move ${p.name} later`}
                        title="Move later"
                        className="p-1.5 hover:bg-black/5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleEditProduct(p)} className="p-1.5 hover:bg-black/5 rounded transition-colors"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => handleDeleteProduct(p.id)} className="p-1.5 hover:bg-red-50 text-red-600 rounded transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
                {!products?.length && <p className="text-sm text-black/40 py-8 text-center">No products yet.</p>}
              </div>
            </div>
          </div>
        )}

        {activeTab === "marketing" && <Marketing />}
        {activeTab === "users" && <Users />}

        {activeTab === "email" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            <Form {...contentForm}>
              <form className="space-y-8">
                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <div className="flex items-center justify-between border-b border-black/10 pb-4">
                    <h2 className="text-xl font-bold">Email Settings</h2>
                    <FormField control={contentForm.control} name="emailEnabled" render={({ field }) => (
                      <FormItem className="flex items-center gap-2 m-0">
                        <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                        <FormLabel className="mt-0 cursor-pointer text-xs uppercase tracking-widest font-bold">Enable emails</FormLabel>
                      </FormItem>
                    )} />
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <FormField control={contentForm.control} name="emailFromName" render={({ field }) => (
                      <FormItem><FormLabel>From Name</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={contentForm.control} name="emailFromAddress" render={({ field }) => (
                      <FormItem>
                        <FormLabel>From Address</FormLabel>
                        <FormControl><Input type="email" {...field} className="rounded-none" placeholder="orders@your-verified-domain.com" /></FormControl>
                        <p className="text-xs text-black/50">Use any sender address at a domain verified in MailerSend.</p>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                  <FormField control={contentForm.control} name="emailReplyTo" render={({ field }) => (
                    <FormItem><FormLabel>Reply-To (optional)</FormLabel><FormControl><Input type="email" {...field} className="rounded-none" placeholder="leave blank to use From Address" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="emailSubject" render={({ field }) => (
                    <FormItem><FormLabel>Subject Line</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>

                <div className="bg-white p-8 border border-black/5 shadow-sm space-y-6">
                  <h2 className="text-xl font-bold border-b border-black/10 pb-4">Email Content</h2>
                  <FormField control={contentForm.control} name="emailHeading" render={({ field }) => (
                    <FormItem><FormLabel>Heading</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="emailIntro" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Intro Message</FormLabel>
                      <p className="text-xs text-black/50">Variables: {`{{customerName}}, {{orderId}}, {{total}}, {{paymentMethod}}`}</p>
                      <FormControl><Textarea {...field} className="rounded-none min-h-[120px]" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={contentForm.control} name="emailButtonLabel" render={({ field }) => (
                    <FormItem><FormLabel>Button Label</FormLabel><FormControl><Input {...field} className="rounded-none" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="emailFooter" render={({ field }) => (
                    <FormItem><FormLabel>Footer Text</FormLabel><FormControl><Textarea {...field} className="rounded-none min-h-[80px]" /></FormControl></FormItem>
                  )} />
                  <FormField control={contentForm.control} name="emailAccentColor" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Accent Color</FormLabel>
                      <div className="flex gap-2">
                        <FormControl><Input type="color" className="w-12 h-10 p-1 rounded-none cursor-pointer" {...field} /></FormControl>
                        <FormControl><Input {...field} className="rounded-none font-mono" /></FormControl>
                      </div>
                    </FormItem>
                  )} />
                </div>

                <div className="bg-white p-6 border border-black/5 shadow-sm space-y-4">
                  <h3 className="font-bold text-sm uppercase tracking-widest">Send Test Email</h3>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      value={testEmailTo}
                      onChange={(e) => setTestEmailTo(e.target.value)}
                      placeholder="your@email.com"
                      className="rounded-none flex-1"
                    />
                    <Button
                      type="button"
                      onClick={handleSendTestEmail}
                      disabled={sendTestEmail.isPending || updateContent.isPending}
                      className="rounded-none bg-black text-white hover:bg-black/80 uppercase tracking-widest text-xs font-bold shrink-0"
                    >
                      <Send className="w-4 h-4 mr-1" />
                      {sendTestEmail.isPending ? "Sending..." : "Send"}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>

            <div className="space-y-4">
              <h3 className="font-bold text-sm uppercase tracking-widest text-black/50">Live Preview</h3>
              <div className="border border-black/10 overflow-hidden" style={{ height: "700px" }}>
                <iframe
                  srcDoc={emailPreviewHtml}
                  className="w-full h-full"
                  sandbox="allow-same-origin"
                  title="Email Preview"
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === "orders" && (
          <div className="space-y-6">
            {devTesting && (
              <div className="flex items-center justify-between gap-4 px-4 py-3 bg-amber-50 border border-amber-300 text-amber-900">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 text-xs font-bold uppercase tracking-widest animate-pulse">
                    ● Testing Active
                  </span>
                  <span className="text-sm">
                    All changes to orders and stock will be reverted when you stop.
                    {devTestCountdown && (
                      <span className="ml-2 font-mono font-bold">{devTestCountdown} remaining</span>
                    )}
                  </span>
                </div>
                <Button
                  type="button"
                  onClick={stopDevTesting}
                  disabled={devTestLoading}
                  className="rounded-none bg-amber-600 hover:bg-amber-700 text-white uppercase tracking-widest text-xs font-bold h-8 px-4 shrink-0"
                >
                  Stop & Revert
                </Button>
              </div>
            )}

            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Recent Orders ({orders?.length ?? 0})</h2>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={exportOrdersToExcel}
                  disabled={!orders?.length}
                  className="rounded-none bg-white border border-black/20 text-black hover:bg-black/5 uppercase tracking-widest text-xs font-bold gap-2 h-9 px-4"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Excel
                </Button>
                <a
                  href="/admin/pos"
                  className="inline-flex items-center gap-2 px-4 h-9 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-widest transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                  POS Checkout
                </a>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm bg-white border border-black/5 shadow-sm">
                <thead>
                  <tr className="border-b border-black/10 bg-black/[0.02] text-left">
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">#</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Customer</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Items</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Total</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Source</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Status</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest">Date</th>
                    <th className="px-4 py-3 font-bold text-xs uppercase tracking-widest"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders?.map((order) => (
                    <tr key={order.id} className="border-b border-black/5 hover:bg-black/[0.01] transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-black/50">#{order.id}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{order.customerName}</p>
                        <p className="text-xs text-black/50">{order.customerEmail}</p>
                        {order.customerPhone && <p className="text-xs text-black/40">{order.customerPhone}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-0.5">
                          {order.items.map((item) => (
                            <p key={item.id} className="text-xs text-black/70">{item.quantity}× {item.productName}</p>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-bold">{formatPrice(order.totalCents, order.currency)}</td>
                      <td className="px-4 py-3 text-xs text-black/50">
                        {order.utmSource
                          ? <span className="font-medium text-black/70">{[order.utmSource, order.utmMedium].filter(Boolean).join(" · ")}{order.utmCampaign ? <><br/><span className="text-black/40">{order.utmCampaign}</span></> : null}</span>
                          : "Direct"
                        }
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={order.status}
                          onChange={(e) => handleStatusChange(order.id, e.target.value as UpdateOrderStatusStatus)}
                          className={`text-xs font-semibold px-2 py-1 rounded-sm border cursor-pointer focus:outline-none ${STATUS_STYLES[order.status] ?? "bg-gray-100 text-gray-600"}`}
                        >
                          {ORDER_STATUSES.map((s) => (
                            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-xs text-black/50">{new Date(order.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openOrderEditor(order)}
                            className="rounded p-1.5 text-black/45 transition-colors hover:bg-black/5 hover:text-black"
                            title="Edit order"
                            aria-label={`Edit order ${order.id}`}
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteOrder(order.id)}
                            className="rounded p-1.5 text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
                            title="Delete order"
                            aria-label={`Delete order ${order.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!orders?.length && (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-black/40">No orders yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Dialog
              open={Boolean(editingOrder && orderEditValues)}
              onOpenChange={(open) => {
                if (!open && !savingOrder) {
                  setEditingOrder(null);
                  setOrderEditValues(null);
                }
              }}
            >
              <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Edit order #{editingOrder?.id}</DialogTitle>
                  <DialogDescription>Update customer and shipping details, notes, or the order discount. Purchased items stay unchanged.</DialogDescription>
                </DialogHeader>
                {orderEditValues && (
                  <form onSubmit={saveOrderEdits} className="space-y-5">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="space-y-1 text-sm font-medium">
                        Customer name
                        <Input required value={orderEditValues.customerName} onChange={(event) => setOrderEditValues({ ...orderEditValues, customerName: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Email
                        <Input required type="email" value={orderEditValues.customerEmail} onChange={(event) => setOrderEditValues({ ...orderEditValues, customerEmail: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium sm:col-span-2">
                        Phone
                        <Input required value={orderEditValues.customerPhone} onChange={(event) => setOrderEditValues({ ...orderEditValues, customerPhone: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium sm:col-span-2">
                        Shipping address
                        <Input required value={orderEditValues.shippingAddress} onChange={(event) => setOrderEditValues({ ...orderEditValues, shippingAddress: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        City
                        <Input required value={orderEditValues.city} onChange={(event) => setOrderEditValues({ ...orderEditValues, city: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Postal code
                        <Input required value={orderEditValues.postalCode} onChange={(event) => setOrderEditValues({ ...orderEditValues, postalCode: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Country
                        <Input required value={orderEditValues.country} onChange={(event) => setOrderEditValues({ ...orderEditValues, country: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Classroom
                        <Input value={orderEditValues.classroom} onChange={(event) => setOrderEditValues({ ...orderEditValues, classroom: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Shipping ($)
                        <Input required type="number" min="0" step="0.01" value={orderEditValues.shipping} onChange={(event) => setOrderEditValues({ ...orderEditValues, shipping: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium">
                        Discount ($)
                        <Input required type="number" min="0" max={(editingOrder?.subtotalCents ?? 0) / 100} step="0.01" value={orderEditValues.discount} onChange={(event) => setOrderEditValues({ ...orderEditValues, discount: event.target.value })} />
                      </label>
                      <label className="space-y-1 text-sm font-medium sm:col-span-2">
                        Order notes
                        <Textarea value={orderEditValues.notes} onChange={(event) => setOrderEditValues({ ...orderEditValues, notes: event.target.value })} rows={3} />
                      </label>
                    </div>
                    <p className="text-sm text-black/55">
                      New total: {editingOrder && (() => {
                        const shipping = currencyInputToCents(orderEditValues.shipping);
                        const discount = currencyInputToCents(orderEditValues.discount);
                        return shipping === null || discount === null
                          ? "Enter valid amounts"
                          : formatPrice(editingOrder.subtotalCents - discount + shipping, editingOrder.currency);
                      })()}
                    </p>
                    <DialogFooter>
                      <Button type="button" variant="outline" disabled={savingOrder} onClick={() => { setEditingOrder(null); setOrderEditValues(null); }}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={savingOrder} className="rounded-none bg-black text-white hover:bg-black/80">
                        {savingOrder ? "Saving..." : "Save order"}
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
    </div>
  );
}

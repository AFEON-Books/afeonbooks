export const onRequest: PagesFunction = async (context) => {
  const maintenance = context.env.MAINTENANCE === 'true';

  if (maintenance) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Maintenance in Progress</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 m-0 p-0">
  <div class="min-h-screen flex items-center justify-center">
    <div class="text-center space-y-6 max-w-md px-4">
      <img src="https://msxfhfdeqxqvjuypcspm.supabase.co/storage/v1/object/public/photos/totec-maintenence.svg" alt="Maintenance" class="w-48 h-48 mx-auto" />
      <div class="space-y-3">
        <h1 class="text-4xl font-bold text-white">Maintenance in Progress</h1>
        <p class="text-lg text-slate-300">We're working to improve your experience. We'll be back soon!</p>
      </div>
      <div class="inline-flex items-center gap-2 px-4 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
        <div class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
        <span class="text-sm text-yellow-200">Service Unavailable</span>
      </div>
    </div>
  </div>
</body>
</html>`,
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '3600',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    );
  }

  return context.next();
};

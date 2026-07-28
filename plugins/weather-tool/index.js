/**
 * Plugin contoh tipe TOOL (blueprint §5).
 * Tool "current" dapat dipanggil agent lewat blok action: weather-tool.current
 * Baca-saja & tanpa side effect -> requiresApproval: false.
 */
export function register(ctx) {
  ctx.tools.register({
    name: 'current',
    description: 'Cuaca terkini sebuah kota (param: city).',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'nama kota, mis. "Jakarta"' } },
      required: ['city'],
    },
    requiresApproval: false,
    timeoutMs: 8000,
    async handler({ city }) {
      if (!city) throw new Error('param "city" wajib');

      const geoRes = await ctx.http(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`);
      const geo = await geoRes.json();
      const place = geo.results?.[0];
      if (!place) return `Kota "${city}" tidak ditemukan.`;

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
        + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto';
      const wxRes = await ctx.http(url);
      const wx = (await wxRes.json()).current;

      const desc = WMO_CODES[wx.weather_code] || `kode ${wx.weather_code}`;
      return `Cuaca di ${place.name}, ${place.country}: ${desc}, ${wx.temperature_2m}°C, `
        + `kelembapan ${wx.relative_humidity_2m}%, angin ${wx.wind_speed_10m} km/j.`;
    },
  });
}

const WMO_CODES = {
  0: 'cerah', 1: 'cerah sebagian', 2: 'berawan sebagian', 3: 'berawan',
  45: 'berkabut', 48: 'kabut beku',
  51: 'gerimis ringan', 53: 'gerimis', 55: 'gerimis lebat',
  61: 'hujan ringan', 63: 'hujan sedang', 65: 'hujan lebat',
  71: 'salju ringan', 73: 'salju sedang', 75: 'salju lebat',
  80: 'hujan lokal ringan', 81: 'hujan lokal', 82: 'hujan lokal lebat',
  95: 'badai petir', 96: 'badai petir + es', 99: 'badai petir hebat',
};

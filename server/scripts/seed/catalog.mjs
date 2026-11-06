// The curated catalogue used by both the demo tenant and the bulk seeders.
//
// WHY REAL PRODUCTS. The assistant can only compare what the catalogue records. A
// generated row called "Premium Kettle 10001" has no model, brand or specification
// to search, so a quality question can only be answered with an honest shrug. These
// entries give the assistant real names, brands, categories and specifications to
// work with while keeping every seed deterministic and offline.
//
// SOURCES. `sourceUrl` is the manufacturer's product or specification page used to
// verify the facts. Where a manufacturer page could not be read, the field contains
// only facts corroborated by the manufacturer's own listing/data sheet or an official
// support page; uncertain numbers (and prices) are deliberately omitted rather than
// invented. Prices are illustrative Philippine peso selling prices for a seeded
// inventory, not a current quote.
//
// NOTHING HERE CONNECTS OR WRITES. It is plain data shared by the seeders.

export const CATALOG_CATEGORIES = Object.freeze([
  { key: 'keyboards-mice', name: 'Keyboards & Mice' },
  { key: 'audio', name: 'Audio' },
  { key: 'displays', name: 'Displays' },
  { key: 'accessories', name: 'Accessories' },
]);

export const CATALOG_PRODUCTS = Object.freeze([
  {
    key: 'mx-keys-s',
    name: 'Logitech MX Keys S',
    brand: 'Logitech',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 4700,
    sellingPrice: 6290,
    description:
      'Low-profile wireless illuminated keyboard with spherically dished scissor keys, smart backlighting and multi-device switching for desktop productivity.',
    specifications:
      'Layout: 108 keys, full-size with numpad; Switches: low-profile scissor; Connectivity: Bluetooth Low Energy or Logi Bolt, USB-C charging; Battery: up to 10 days with backlight, up to 5 months without; Size: 430.2 x 131.63 x 20.5 mm; Weight: 810 g',
    sourceUrl: 'https://www.logitech.com/en-us/shop/p/mx-keys-s',
  },
  {
    key: 'keychron-k8-pro',
    name: 'Keychron K8 Pro',
    brand: 'Keychron',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 5200,
    sellingPrice: 6990,
    description:
      'Tenkeyless wireless mechanical keyboard with QMK/VIA remapping, hot-swappable switches and double-shot PBT keycaps for office and enthusiast use.',
    specifications:
      'Layout: 80% TKL, 87 keys; Switches: hot-swappable Gateron G Pro; Connectivity: Bluetooth 5.1 for up to 3 devices and USB-C; Battery: 4000 mAh; Keycaps: double-shot PBT OSA; Firmware: QMK/VIA',
    sourceUrl: 'https://www.keychron.com/products/keychron-k8-pro-qmk-via-wireless-mechanical-keyboard',
  },
  {
    key: 'rog-flare-ii',
    name: 'ASUS ROG Strix Flare II Animate',
    brand: 'ASUS ROG',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 9300,
    sellingPrice: 11995,
    description:
      'Full-size wired mechanical gaming keyboard with an AniMe Matrix LED display, per-key RGB, front underglow and a detachable wrist rest.',
    specifications:
      'Layout: 100% full-size; Switches: hot-swappable Cherry MX or ROG NX; Connectivity: USB-C to USB-A, 2 m braided cable; Lighting: AniMe Matrix LED, per-key RGB and front underglow; Ports: USB 2.0 pass-through; Size: 435 x 165 x 38 mm; Weight: 1157 g',
    sourceUrl: 'https://rog.asus.com/keyboards/keyboards/pbt-keycaps/rog-strix-flare-ii-animate-model/spec/',
  },
  {
    key: 'razer-blackwidow-v4-pro',
    name: 'Razer BlackWidow V4 Pro',
    brand: 'Razer',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 10200,
    sellingPrice: 12995,
    description:
      'Full-size wired mechanical gaming keyboard with a programmable command dial, dedicated macro keys and two-zone Chroma RGB lighting.',
    specifications:
      'Layout: full-size with 8 macro keys; Switches: Razer Green, Orange or Yellow; Connectivity: wired USB-C; Controls: Command Dial, multi-function roller and 4 media keys; Keycaps: doubleshot ABS; Lighting: per-key Chroma RGB and underglow; Wrist rest: magnetic plush leatherette',
    sourceUrl: 'https://www.razer.com/gaming-keyboards/razer-blackwidow-v4-pro',
  },
  {
    key: 'royal-kludge-rk61',
    name: 'Royal Kludge RK61',
    brand: 'Royal Kludge',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 1800,
    sellingPrice: 2499,
    description:
      'Compact 60% wireless mechanical keyboard with 61 keys and tri-mode connectivity, aimed at a small desk footprint and portable use.',
    specifications:
      'Layout: 60%, 61 keys; Connectivity: Bluetooth 5.1, 2.4 GHz dongle and USB-C; Switches: mechanical, hot-swap on some variants; Form factor: compact without a function row or numpad',
    sourceUrl: 'https://rkgamingstore.com/products/rk61-60-percent-keyboard',
  },
  {
    key: 'mx-master-3s',
    name: 'Logitech MX Master 3S',
    brand: 'Logitech',
    category: 'keyboards-mice',
    unit: 'pcs',
    costPrice: 4100,
    sellingPrice: 5490,
    description:
      'Ergonomic wireless productivity mouse with a Darkfield sensor that tracks on glass, near-silent clicks and an electromagnetic thumb wheel.',
    specifications:
      'Sensor: Darkfield high precision, tracks on glass; Connectivity: Bluetooth Low Energy or Logi Bolt; Battery: 500 mAh rechargeable Li-Po; Size: 124.9 x 84.3 x 51 mm; Weight: 141 g; Buttons: 8 including thumbwheel and gesture button',
    sourceUrl:
      'https://hub.sync.logitech.com/mx-master-3s/post/specifications---mx-master-3s-for-business-YAOnlMzTGrkzjuy',
  },
  {
    key: 'sony-wh-1000xm5',
    name: 'Sony WH-1000XM5',
    brand: 'Sony',
    category: 'audio',
    unit: 'pcs',
    costPrice: 15600,
    sellingPrice: 19990,
    description:
      'Over-ear wireless noise-cancelling headphones with two processors driving eight microphones and multipoint Bluetooth connection.',
    specifications:
      'Type: closed-back over-ear; Driver: 30 mm carbon-fibre composite; Battery: up to 30 h with ANC, up to 40 h without; Charging: USB-C, 3 minutes for about 3 hours; Connectivity: Bluetooth 5.2, multipoint and 3.5 mm wired; Weight: 250 g',
    sourceUrl:
      'https://www.sony.com/electronics/support/wireless-headphones-bluetooth-headphones/wh-1000xm5/specifications',
  },
  {
    key: 'arctis-nova-7',
    name: 'SteelSeries Arctis Nova 7',
    brand: 'SteelSeries',
    category: 'audio',
    unit: 'pcs',
    costPrice: 7900,
    sellingPrice: 9995,
    description:
      'Multi-platform wireless gaming headset with low-latency 2.4 GHz and simultaneous Bluetooth audio, plus a retractable ClearCast microphone.',
    specifications:
      'Battery: up to 38 h on 2.4 GHz; Connectivity: 2.4 GHz dongle, Bluetooth and 3.5 mm; Charging: USB-C, 15 minutes for about 6 hours; Audio: Nova Acoustic System; Microphone: ClearCast Gen 2 retractable',
    sourceUrl: 'https://steelseries.com/gaming-headsets/arctis-nova-7',
  },
  {
    key: 'dell-u2723qe',
    name: 'Dell UltraSharp U2723QE',
    brand: 'Dell',
    category: 'displays',
    unit: 'pcs',
    costPrice: 31000,
    sellingPrice: 38990,
    description:
      '27-inch 4K USB-C hub monitor using IPS Black panel technology, with built-in Ethernet and power delivery for single-cable laptop docking.',
    specifications:
      'Panel: 27 in IPS Black, 3840 x 2160 at 60 Hz; Contrast: 2000:1; Brightness: 340 cd/m2 typical; USB-C power delivery: 90 W; Ports: USB-C, DisplayPort 1.4, HDMI, RJ45 Ethernet and USB-A; Size: 611.4 x 353.0 x 54.3 mm without stand; Weight: 4.48 kg',
    sourceUrl:
      'https://www.dell.com/en-us/shop/dell-ultrasharp-27-4k-usb-c-hub-monitor-u2723qe/apd/210-bdpf/monitors-monitor-accessories',
  },
  {
    key: 'lg-27gp850-b',
    name: 'LG UltraGear 27GP850-B',
    brand: 'LG',
    category: 'displays',
    unit: 'pcs',
    costPrice: 18000,
    sellingPrice: 22995,
    description:
      '27-inch QHD Nano IPS gaming monitor with a 1 ms response, 165 Hz native refresh rate and support for NVIDIA G-SYNC Compatible and AMD FreeSync Premium.',
    specifications:
      'Panel: 27 in Nano IPS, 2560 x 1440; Refresh: 165 Hz native, 180 Hz overclock; Response: 1 ms GtG; HDR: VESA DisplayHDR 400; Colour: DCI-P3 98%; Ports: 2x HDMI 2.0, DisplayPort 1.4 and USB 3.0 hub; Weight: 4.2 kg without stand',
    sourceUrl: 'https://www.lg.com/us/monitors/lg-27gp850-b-gaming-monitor',
  },
  {
    key: 'anker-737',
    name: 'Anker 737 Power Bank',
    brand: 'Anker',
    category: 'accessories',
    unit: 'pcs',
    costPrice: 7000,
    sellingPrice: 8995,
    description:
      'High-capacity power bank with 140 W two-way USB-C charging and a smart display showing output, input and battery health.',
    specifications:
      'Capacity: 24,000 mAh; Output: 140 W maximum, USB PD 3.1; Ports: 2x USB-C and 1x USB-A; Display: smart digital display; Size: 155.7 x 54.6 x 49.5 mm; Weight: 630 g',
    sourceUrl: 'https://www.anker.com/products/a1289',
  },
  {
    key: 'samsung-t7-shield',
    name: 'Samsung Portable SSD T7 Shield 1TB',
    brand: 'Samsung',
    category: 'accessories',
    unit: 'pcs',
    costPrice: 6200,
    sellingPrice: 7995,
    description:
      'Rugged rubber-cased portable SSD with USB 3.2 Gen 2 speeds, IP65 dust and water resistance and drop protection for travel and field work.',
    specifications:
      'Capacity: 1 TB; Interface: USB 3.2 Gen 2, USB-C; Sequential read: up to 1,050 MB/s; Sequential write: up to 1,000 MB/s; Durability: IP65 and 3 m drop resistance; Size: 59 x 88 x 13 mm; Weight: 98 g',
    sourceUrl:
      'https://www.samsung.com/us/memory-storage/portable-ssd/portable-ssd-t7-shield-usb-3-2-1tb-black-sku-mu-pe1t0s-am/',
  },
  {
    key: 'logitech-c920s',
    name: 'Logitech C920s HD Pro Webcam',
    brand: 'Logitech',
    category: 'accessories',
    unit: 'pcs',
    costPrice: 2500,
    sellingPrice: 3495,
    description:
      'Full HD webcam with a glass lens, automatic light correction, dual stereo microphones and an attachable privacy shutter for desk meetings.',
    specifications:
      'Video: 1080p at 30 fps; Lens: full-HD glass, 78 degree field of view; Focus: autofocus; Microphones: dual stereo; Privacy: attachable shutter; Mount: adjustable clip; Cable: USB-A',
    sourceUrl: 'https://www.logitech.com/en-us/shop/p/c920s-pro-hd-webcam',
  },
  {
    key: 'elgato-stream-deck-mk2',
    name: 'Elgato Stream Deck MK.2',
    brand: 'Elgato',
    category: 'accessories',
    unit: 'pcs',
    costPrice: 7100,
    sellingPrice: 8995,
    description:
      'Desktop control pad with 15 customizable LCD keys for launching actions, adjusting audio and controlling apps during streams or calls.',
    specifications:
      'Keys: 15 customizable LCD keys; Interface: USB 2.0, USB-C; Size: 118 x 84 x 25 mm without stand; Weight: 145 g without stand; Stand: detachable 45-degree; Compatibility: macOS and Windows',
    sourceUrl: 'https://help.elgato.com/hc/en-us/articles/18208816152333-Elgato-Stream-Deck-MK-2-Technical-Specifications',
  },
]);

/** The catalogue row a seeded product index uses. Exported so tests need no copy. */
export function catalogProductAt(index) {
  return CATALOG_PRODUCTS[((index % CATALOG_PRODUCTS.length) + CATALOG_PRODUCTS.length) % CATALOG_PRODUCTS.length];
}

export default { CATALOG_CATEGORIES, CATALOG_PRODUCTS, catalogProductAt };

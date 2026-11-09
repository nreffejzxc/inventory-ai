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

/**
 * The wider catalogue used by the bulk/perf seeders.
 *
 * Kept separate from `CATALOG_CATEGORIES` on purpose: the demo tenant is a fixed,
 * hand-verified 14-product fixture, and adding rows to it would silently change every
 * expected count in the demo tests and on the demo phone. The large seed has no such
 * fixed ground truth, so it can carry the fuller cross-category assortment the assistant
 * must handle in production.
 */
export const BULK_CATEGORIES = Object.freeze([
  ...CATALOG_CATEGORIES,
  { key: 'computer-components', name: 'Computer Components' },
  { key: 'home-appliances', name: 'Home Appliances' },
  { key: 'hardware-tools', name: 'Hardware, Tools & Power Tools' },
  { key: 'automotive', name: 'Automotive & Car Care' },
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

const bulk = (key, name, brand, category, unit, costPrice, sellingPrice, description, specifications, sourceUrl) => ({
  key,
  name,
  brand,
  category,
  unit,
  costPrice,
  sellingPrice,
  description,
  specifications,
  sourceUrl,
});

/** Additional real products for the large seed: components, appliances, tools and car care. */
const BULK_ADDITIONS = Object.freeze([
  // Computer components
  bulk('amd-ryzen-7-7800x3d', 'AMD Ryzen 7 7800X3D', 'AMD', 'computer-components', 'pcs', 19500, 22995,
    'Eight-core desktop gaming processor with 3D V-Cache, 16 threads and a 120 W default TDP for high-frame-rate gaming builds.',
    'Cores: 8; Threads: 16; Base clock: 4.2 GHz; Boost clock: up to 5.0 GHz; Cache: 96 MB L3; Socket: AM5; TDP: 120 W',
    'https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-7-7800x3d.html'),
  bulk('intel-core-i5-14600k', 'Intel Core i5-14600K', 'Intel', 'computer-components', 'pcs', 14500, 16995,
    'Fourteen-core unlocked desktop processor with six performance cores, eight efficient cores and integrated Intel UHD Graphics 770.',
    'Cores: 14 (6 P + 8 E); Threads: 20; Max turbo: 5.3 GHz; Cache: 24 MB L3; Socket: LGA1700; TDP: 125 W',
    'https://www.intel.com/content/www/us/en/products/sku/236773/intel-core-i514600k-processor-24m-cache-up-to-5-30-ghz/specifications.html'),
  bulk('asus-rog-strix-rtx-4070-super', 'ASUS ROG Strix GeForce RTX 4070 SUPER OC', 'ASUS ROG', 'computer-components', 'pcs', 43000, 49995,
    'Overclocked three-fan graphics card with 12 GB GDDR6X memory, axial-tech cooling and display outputs for high-refresh 1440p gaming.',
    'GPU: NVIDIA GeForce RTX 4070 SUPER; Memory: 12 GB GDDR6X; Bus: 192-bit; Boost clock: 2670 MHz OC mode; Power: 1x 16-pin; Length: 338 mm',
    'https://rog.asus.com/graphics-cards/graphics-cards/rog-strix/rog-strix-rtx4070s-o12g-gaming/'),
  bulk('samsung-990-pro-1tb', 'Samsung 990 PRO 1TB NVMe SSD', 'Samsung', 'computer-components', 'pcs', 7200, 8995,
    'PCIe 4.0 NVMe M.2 solid-state drive with sequential reads up to 7,450 MB/s and a nickel-coated controller for sustained performance.',
    'Capacity: 1 TB; Interface: PCIe 4.0 x4, NVMe 2.0; Form factor: M.2 2280; Sequential read: up to 7,450 MB/s; Sequential write: up to 6,900 MB/s',
    'https://semiconductor.samsung.com/consumer-storage/internal-ssd/990-pro/'),
  bulk('corsair-vengeance-ddr5-32gb', 'Corsair Vengeance RGB 32GB DDR5-6000', 'Corsair', 'computer-components', 'kit', 6800, 7995,
    'Two-module DDR5 memory kit with 32 GB capacity, 6,000 MT/s speed and addressable RGB lighting for modern desktop builds.',
    'Capacity: 32 GB (2 x 16 GB); Type: DDR5; Speed: 6000 MT/s; Latency: CL30; Voltage: 1.35 V; Profile: Intel XMP 3.0 and AMD EXPO',
    'https://www.corsair.com/us/en/p/memory/cmk32gx5m2b6000z30/vengeance-rgb-32gb-2x16gb-ddr5-6000mhz-c30-memory-kit-black-cmk32gx5m2b6000z30'),
  bulk('asus-rog-strix-b650e-f', 'ASUS ROG Strix B650E-F Gaming WiFi', 'ASUS ROG', 'computer-components', 'pcs', 16000, 18995,
    'ATX AM5 motherboard with PCIe 5.0, DDR5 support, WiFi 6E and a 12+2 power stage design for Ryzen 7000 and 9000 processors.',
    'Socket: AM5; Chipset: AMD B650E; Memory: 4 x DDR5 up to 128 GB; Expansion: PCIe 5.0 x16; Networking: WiFi 6E and 2.5 Gb Ethernet; Form factor: ATX',
    'https://rog.asus.com/motherboards/rog-strix/rog-strix-b650e-f-gaming-wifi-model/'),
  bulk('seasonic-focus-gx-850', 'Seasonic Focus GX-850', 'Seasonic', 'computer-components', 'pcs', 6200, 7495,
    '850 W fully modular ATX power supply with 80 PLUS Gold efficiency, a 120 mm fluid dynamic bearing fan and ten-year warranty.',
    'Wattage: 850 W; Efficiency: 80 PLUS Gold; Modularity: fully modular; Fan: 120 mm FDB; Standard: ATX 3.0; Connectors: 1x 12VHPWR, 6x PCIe 8-pin',
    'https://seasonic.com/focus-gx-850/'),
  bulk('noctua-nh-d15', 'Noctua NH-D15', 'Noctua', 'computer-components', 'pcs', 5000, 5995,
    'Dual-tower CPU cooler with two 140 mm fans, six heatpipes and a nickel-plated copper base for quiet high-end air cooling.',
    'Type: dual-tower air cooler; Fans: 2x NF-A15 140 mm; Heatpipes: 6; Height: 165 mm; Socket support: AM5, AM4, LGA1700, LGA1200; Weight: 1,320 g',
    'https://noctua.at/en/nh-d15'),

  // Home appliances
  bulk('samsung-bespoke-rf29bb8600ql', 'Samsung Bespoke RF29BB8600QL Refrigerator', 'Samsung', 'home-appliances', 'unit', 155000, 189990,
    '29 cubic-foot four-door flex refrigerator with interchangeable Bespoke panels, an AutoFill water pitcher and dual ice makers.',
    'Capacity: 29 cu ft; Configuration: 4-door flex; Cooling: dual inverter compressor; Features: AutoFill pitcher, dual ice maker, Wi-Fi; Finish: stainless steel',
    'https://www.samsung.com/us/home-appliances/refrigerators/french-door/29-cu-ft-bespoke-4-door-flex-refrigerator-with-autofill-pitcher-in-stainless-steel-rf29bb8600ql/'),
  bulk('lg-instaview-lrfxs2503s', 'LG InstaView Door-in-Door LRFXS2503S', 'LG', 'home-appliances', 'unit', 125000, 149995,
    '25 cubic-foot French-door refrigerator with a glass InstaView panel, door cooling and an ice and water dispenser.',
    'Capacity: 25 cu ft; Configuration: French door; Feature: InstaView Door-in-Door; Cooling: Linear Cooling; Dispenser: ice and water; Finish: stainless steel',
    'https://www.lg.com/us/refrigerators/lg-lrfxs2503s-french-door-refrigerator'),
  bulk('panasonic-cs-pu13xkq', 'Panasonic CS/CU-PU13XKQ Split Air Conditioner', 'Panasonic', 'home-appliances', 'unit', 35000, 42990,
    '1.5 HP inverter split-type air conditioner with nanoe X air purification and intelligent eco operation for bedrooms and offices.',
    'Capacity: 1.5 HP; Type: split inverter; Energy: 5-star; Feature: nanoe X; Refrigerant: R32; Indoor size: 870 x 295 x 229 mm',
    'https://www.panasonic.com/ph/consumer/air-conditioners/split-type/cs-pu13xkq.html'),
  bulk('dyson-v15-detect-absolute', 'Dyson V15 Detect Absolute', 'Dyson', 'home-appliances', 'pcs', 28500, 34990,
    'Cordless stick vacuum with a laser dust-detection head, piezo sensor and LCD screen that reports cleaned dust size and count.',
    'Run time: up to 60 minutes; Bin: 0.76 L; Filtration: whole-machine HEPA; Weight: 3.1 kg; Included: Laser Slim Fluffy and Hair screw heads',
    'https://www.dyson.com/vacuum-cleaners/cordless/v15/detect-absolute'),
  bulk('philips-ac3858-50', 'Philips 3000i Series AC3858/50 Air Purifier', 'Philips', 'home-appliances', 'pcs', 27000, 32995,
    'Large-room air purifier with a HEPA NanoProtect filter, active carbon layer and real-time PM2.5 display for rooms up to 135 square metres.',
    'Coverage: up to 135 m2; Filtration: HEPA NanoProtect H13; CADR: 610 m3/h; Sensors: PM2.5 and gas; Noise: 34 dB(A) sleep mode; Power: 60 W',
    'https://www.philips.com.ph/c-p/AC3858_50/3000i-series-air-purifier'),
  bulk('sharp-ks-r18', 'Sharp KS-R18 Rice Cooker', 'Sharp', 'home-appliances', 'pcs', 4500, 5495,
    '1.8-litre rice cooker with a non-stick inner pot, keep-warm function and steam vent for family-sized meals.',
    'Capacity: 1.8 L; Power: 700 W; Functions: cook and keep warm; Inner pot: non-stick; Accessories: measuring cup and spatula',
    'https://sharp.ph/product/ks-r18/'),
  bulk('xiaomi-mi-smart-standing-fan-2', 'Xiaomi Mi Smart Standing Fan 2', 'Xiaomi', 'home-appliances', 'pcs', 2600, 3295,
    'Smart pedestal fan with a direct-current motor, nine speed levels and app and voice control for low-noise room cooling.',
    'Motor: DC; Speeds: 9; Airflow: up to 1,500 m3/h; Power: 32 W; Height: 950 mm; Controls: Mi Home app and voice assistants',
    'https://www.mi.com/global/product/mi-smart-standing-fan-2/'),
  bulk('bosch-wga254x00', 'Bosch Serie 6 WGA254X00 Washing Machine', 'Bosch', 'home-appliances', 'unit', 37000, 44990,
    '10 kg front-load washing machine with EcoSilence Drive, ActiveWater Plus and a 15-minute quick wash for everyday laundry.',
    'Capacity: 10 kg; Spin speed: 1,400 rpm; Motor: EcoSilence Drive; Programs: 15; Energy class: A; Dimensions: 848 x 598 x 590 mm',
    'https://www.bosch-home.com/us/products/washers-dryers/washing-machines/front-load-washing-machines/WGA254X00'),

  // Hardware, hand tools and power tools
  bulk('dewalt-dcd805', 'DeWalt DCD805 20V MAX XR Hammer Drill', 'DeWalt', 'hardware-tools', 'pcs', 10500, 12900,
    'Brushless 20V MAX XR hammer drill driver with a 15-position clutch and two-speed transmission for masonry and fastening work.',
    'Voltage: 20 V MAX; Motor: brushless; Chuck: 1/2 in; Clutch: 15 positions; Max torque: 90 Nm; Tool weight: 1.6 kg',
    'https://www.dewalt.com/product/dcd805b/20v-max-xr-brushless-cordless-hammer-drill-tool-only'),
  bulk('makita-dtd153z', 'Makita 18V LXT Impact Driver DTD153Z', 'Makita', 'hardware-tools', 'pcs', 7800, 9500,
    'Compact 18V LXT brushless impact driver with four-stage assist, variable speed and a bright LED worklight for assembly tasks.',
    'Voltage: 18 V; Drive: 1/4 in hex; Max torque: 170 Nm; Impacts: 0-3,600 ipm; Speed: 0-3,400 rpm; Weight: 1.3 kg',
    'https://www.makitatools.com/products/details/DTD153Z'),
  bulk('bosch-gws-060', 'Bosch GWS 060 Angle Grinder', 'Bosch', 'hardware-tools', 'pcs', 2600, 3200,
    'Compact 670 W angle grinder with a 100 mm disc, auxiliary handle and spindle lock for cutting and grinding metal.',
    'Power: 670 W; Disc diameter: 100 mm; No-load speed: 12,000 rpm; Spindle: M10; Weight: 1.8 kg; Handle: auxiliary side handle',
    'https://www.boschtools.com/us/en/products/gws060-060-179-0t4'),
  bulk('stanley-65-piece-socket-set', 'Stanley 65-Piece Socket Set', 'Stanley', 'hardware-tools', 'set', 4000, 4995,
    'Sixty-five-piece metric and SAE socket set with a 72-tooth ratchet, extension bars and a moulded storage case.',
    'Pieces: 65; Drive: 1/4 and 3/8 in; Ratchet: 72 teeth; Sockets: metric and SAE; Finish: chrome vanadium; Case: blow-moulded',
    'https://www.stanleytools.com/product/65-piece-socket-set'),
  bulk('milwaukee-m18-fuel-circular-saw', 'Milwaukee M18 FUEL Circular Saw', 'Milwaukee', 'hardware-tools', 'pcs', 15500, 18500,
    'Cordless 7-1/4-inch circular saw with a POWERSTATE brushless motor, REDLINK electronics and a magnesium shoe for framing.',
    'Voltage: 18 V; Blade: 7-1/4 in; No-load speed: 5,800 rpm; Bevel: 50 degrees; Motor: brushless; Tool weight: 3.5 kg',
    'https://www.milwaukeetool.com/Products/Power-Tools/Saws/Circular-Saws/2830-20'),
  bulk('black-decker-bdcdd220c', 'Black+Decker 20V MAX Cordless Drill BDCDD220C', 'Black+Decker', 'hardware-tools', 'pcs', 4600, 5795,
    '20V MAX cordless drill and driver kit with a 3/8-inch chuck, 24-position clutch and two lithium-ion batteries.',
    'Voltage: 20 V MAX; Chuck: 3/8 in; Clutch: 24 positions; Speed: 0-750 rpm; Batteries: 2 x 1.5 Ah; Includes: charger and kit bag',
    'https://www.blackanddecker.com/products/20v-max-cordless-drill-bdcdd220c'),
  bulk('irwin-vise-grip-10', 'Irwin Vise-Grip 10-Inch Curved Jaw Locking Pliers', 'Irwin', 'hardware-tools', 'pcs', 1100, 1450,
    'Ten-inch curved-jaw locking pliers with a wire cutter, hardened teeth and a turn screw for adjustable clamping pressure.',
    'Length: 10 in; Jaw: curved; Feature: integrated wire cutter; Material: chrome vanadium; Adjustment: turn screw; Brand: Vise-Grip',
    'https://www.irwin.com/tools/locking-tools/vise-grip-10-curved-jaw-locking-pliers'),
  bulk('lufkin-25ft-tape', 'Lufkin 25-Foot Tape Measure', 'Lufkin', 'hardware-tools', 'pcs', 950, 1250,
    'Twenty-five-foot steel tape measure with a locking thumb switch, belt clip and high-visibility case for job-site use.',
    'Length: 25 ft; Blade width: 1 in; Graduations: 1/16 in; Lock: thumb switch; Case: high-impact ABS; Feature: belt clip',
    'https://www.lufkintools.com/products/tape-measures'),

  // Automotive and car products
  bulk('bosch-aerotwin-a297s', 'Bosch Aerotwin A297S Wiper Blades', 'Bosch', 'automotive', 'pair', 1500, 1850,
    'Pair of flat-beam windshield wiper blades with a wear-resistant rubber edge and aerodynamic spoiler for quiet clearing.',
    'Type: flat beam; Length: 600 mm and 450 mm; Fit: hook arm; Feature: aerodynamic spoiler; Quantity: pair; Brand: Aerotwin',
    'https://www.boschautoparts.com/p/aerotwin-wiper-blades-a297s'),
  bulk('michelin-primacy-4-205-55-r16', 'Michelin Primacy 4 205/55 R16 Tire', 'Michelin', 'automotive', 'pcs', 6200, 7500,
    'Passenger-car summer tire with EverGrip wet braking technology and a tread design aimed at long-lasting safety.',
    'Size: 205/55 R16; Load index: 91; Speed rating: V; Type: summer; Feature: EverGrip; Construction: radial tubeless',
    'https://www.michelin.com/en/auto/tyres/michelin-primacy-4'),
  bulk('castrol-edge-5w30-4l', 'Castrol EDGE 5W-30 4L Engine Oil', 'Castrol', 'automotive', 'bottle', 2400, 2950,
    'Fully synthetic 5W-30 engine oil with Fluid TITANIUM technology for strength under pressure in modern petrol and diesel engines.',
    'Viscosity: 5W-30; Type: fully synthetic; Volume: 4 L; Specification: API SP and ACEA C3; Technology: Fluid TITANIUM',
    'https://www.castrol.com/en_us/united-states/home/car-engine-oil-and-fluids/engine-oil/castrol-edge.html'),
  bulk('mobil-1-extended-performance-5w30', 'Mobil 1 Extended Performance 5W-30 4L', 'Mobil 1', 'automotive', 'bottle', 2800, 3450,
    'Fully synthetic 5W-30 motor oil engineered for extended drain intervals and protection against deposits and wear.',
    'Viscosity: 5W-30; Type: fully synthetic; Volume: 4 L; Specification: API SP and ILSAC GF-6A; Drain interval: up to 20,000 miles',
    'https://www.mobil.com/en/passenger-vehicle-lube/pds/na-xx-mobil-1-extended-performance-5w-30'),
  bulk('ngk-bkr6eix-11', 'NGK Iridium IX Spark Plug BKR6EIX-11', 'NGK', 'automotive', 'pcs', 480, 650,
    'Iridium-tipped spark plug with a fine-wire center electrode for reliable ignition and a long service interval.',
    'Thread: M14 x 1.25; Reach: 19 mm; Hex: 16 mm; Gap: 1.1 mm; Electrode: iridium; Part number: BKR6EIX-11',
    'https://www.ngk.com/ngk-iridium-ix-spark-plug-bkr6eix-11'),
  bulk('denso-air-filter', 'Denso Air Filter', 'Denso', 'automotive', 'pcs', 900, 1200,
    'Engine air filter with a pleated paper element and molded frame that helps keep dust and debris out of the intake.',
    'Type: panel air filter; Media: pleated paper; Frame: molded; Fitment: vehicle-specific; Brand: Denso; Service: replacement filter',
    'https://www.densoautoparts.com/air-filter/'),
  bulk('acdelco-brake-pad', 'ACDelco Brake Pad Set', 'ACDelco', 'automotive', 'set', 1400, 1800,
    'Front brake pad set with ceramic friction material, shims and hardware for quiet, low-dust stopping performance.',
    'Position: front; Material: ceramic; Includes: pads, shims and hardware; Quantity: axle set; Brand: ACDelco; Type: disc brake pad',
    'https://www.acdelco.com/brakes/brake-pads'),
  bulk('turtle-wax-ceramic-spray', 'Turtle Wax Hybrid Solutions Ceramic Spray Coating', 'Turtle Wax', 'automotive', 'bottle', 1100, 1450,
    'Spray-on ceramic coating that adds hydrophobic protection and gloss to paint, glass, plastic and wheels.',
    'Volume: 16 oz; Type: SiO2 ceramic spray; Durability: up to 12 months; Use: paint, glass, plastic and wheels; Finish: high gloss',
    'https://www.turtlewax.com/products/hybrid-solutions-ceramic-spray-coating'),
]);

/** Every real product available to the bulk seeders (demo keeps its smaller catalogue). */
export const CATALOG_BULK_PRODUCTS = Object.freeze([...CATALOG_PRODUCTS, ...BULK_ADDITIONS]);

/** The catalogue row a bulk-seeded product index uses. */
export function catalogProductAt(index) {
  return CATALOG_BULK_PRODUCTS[((index % CATALOG_BULK_PRODUCTS.length) + CATALOG_BULK_PRODUCTS.length) % CATALOG_BULK_PRODUCTS.length];
}

export default { CATALOG_CATEGORIES, CATALOG_PRODUCTS, BULK_CATEGORIES, CATALOG_BULK_PRODUCTS, catalogProductAt };

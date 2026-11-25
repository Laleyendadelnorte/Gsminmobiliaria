import "./env";
import { db } from "../src/server/db";
import { bootstrap } from "./bootstrap";
import {
  atomic,
  sql,
  createProperty,
  createProspect,
  createOfferDraft,
  publishOffer,
  termsText,
} from "../src/server/domain";
import { createVisit, createSlot } from "../src/server/visits";
import { sandboxPay } from "../src/server/payments";
const demoProperties = [
  {
    title: "Casa Brisa · Jardines del Este",
    type: "CASA",
    price: 7600000,
    zone: "Santo Domingo Este",
    sector: "Prado Oriental",
    beds: 3,
    area: 235,
    land: 290,
    features: ["piscina", "seguridad privada", "patio", "moderna", "terraza"],
    photo: 1,
  },
  {
    title: "Casa Patio · Los Corales",
    type: "CASA",
    price: 7200000,
    zone: "Santo Domingo Este",
    sector: "Los Corales",
    beds: 3,
    area: 210,
    land: 275,
    features: ["piscina", "seguridad privada", "patio", "moderna"],
    photo: 2,
  },
  {
    title: "Casa Alba · Ciudad Juan Bosch",
    type: "CASA",
    price: 7950000,
    zone: "Santo Domingo Este",
    sector: "Ciudad Juan Bosch",
    beds: 3,
    area: 248,
    land: 310,
    features: ["piscina", "seguridad privada", "moderna", "terraza"],
    photo: 3,
  },
  {
    title: "Apartamento Luz · Ensanche Ozama",
    type: "APARTAMENTO",
    price: 5800000,
    zone: "Santo Domingo Este",
    sector: "Ensanche Ozama",
    beds: 3,
    area: 150,
    land: null,
    features: ["ascensor", "seguridad privada", "balcón"],
    photo: 4,
  },
  {
    title: "Casa Olivo · Arroyo Hondo",
    type: "CASA",
    price: 13500000,
    zone: "Distrito Nacional",
    sector: "Arroyo Hondo",
    beds: 4,
    area: 350,
    land: 480,
    features: ["patio", "piscina", "seguridad privada"],
    photo: 5,
  },
  {
    title: "Apartamento Altura · Naco",
    type: "APARTAMENTO",
    price: 240000,
    currency: "USD",
    zone: "Distrito Nacional",
    sector: "Naco",
    beds: 2,
    area: 142,
    land: null,
    features: ["ascensor", "gimnasio", "seguridad privada", "terraza"],
    photo: 6,
  },
  {
    title: "Villa Mar · Punta Cana",
    type: "VILLA",
    price: 385000,
    currency: "USD",
    zone: "Punta Cana",
    sector: "Bávaro",
    beds: 4,
    area: 320,
    land: 500,
    features: ["piscina", "patio", "seguridad privada", "moderna"],
    photo: 1,
  },
  {
    title: "Solar Jardín · San Isidro",
    type: "SOLAR",
    price: 3200000,
    zone: "Santo Domingo Este",
    sector: "San Isidro",
    beds: null,
    area: null,
    land: 400,
    features: [],
    photo: 2,
  },
  {
    title: "Terreno Horizonte · Jarabacoa",
    type: "TERRENO",
    price: 4500000,
    zone: "Jarabacoa",
    sector: "Buena Vista",
    beds: null,
    area: null,
    land: 1200,
    features: ["vista a la montaña"],
    photo: 3,
  },
  {
    title: "Local Ángulo · Piantini",
    type: "LOCAL",
    price: 55000,
    operation: "ALQUILER",
    zone: "Distrito Nacional",
    sector: "Piantini",
    beds: null,
    area: 85,
    land: null,
    features: ["parqueo", "seguridad privada"],
    photo: 4,
  },
  {
    title: "Finca Sendero · Monte Plata",
    type: "FINCA",
    price: 11500000,
    zone: "Monte Plata",
    sector: "Yamasá",
    beds: 2,
    area: 160,
    land: 10000,
    features: ["patio"],
    photo: 5,
  },
  {
    title: "Penthouse Cielo · Bella Vista",
    type: "PENTHOUSE",
    price: 420000,
    currency: "USD",
    zone: "Distrito Nacional",
    sector: "Bella Vista",
    beds: 4,
    area: 370,
    land: null,
    features: ["piscina", "terraza", "ascensor", "seguridad privada"],
    photo: 6,
  },
  {
    title: "Apartamento Serena · Alma Rosa",
    type: "APARTAMENTO",
    price: 35000,
    operation: "ALQUILER",
    zone: "Santo Domingo Este",
    sector: "Alma Rosa",
    beds: 2,
    area: 110,
    land: null,
    features: ["balcón", "seguridad privada"],
    photo: 4,
  },
  {
    title: "Casa Roble · Santiago",
    type: "CASA",
    price: 6900000,
    zone: "Santiago",
    sector: "Los Álamos",
    beds: 3,
    area: 220,
    land: 300,
    features: ["patio", "marquesina"],
    photo: 2,
  },
  {
    title: "Casa Palmeras · Santo Domingo Norte",
    type: "CASA",
    price: 8200000,
    zone: "Santo Domingo Norte",
    sector: "El Higüero",
    beds: 4,
    area: 280,
    land: 360,
    features: ["piscina", "patio", "seguridad privada"],
    photo: 1,
  },
];
export async function seed() {
  if (process.env.ALLOW_DEMO_SEED !== "true")
    throw new Error(
      "Set ALLOW_DEMO_SEED=true explicitly to insert fictional demonstration data.",
    );
  const ctx = await bootstrap();
  return atomic(ctx, async (tx) => {
    await sql(
      tx,
      "SELECT pg_advisory_xact_lock(hashtextextended('gcm:seed',0))",
    );
    const ids: string[] = [];
    for (let i = 0; i < demoProperties.length; i++) {
      const p = demoProperties[i];
      const code = `DEMO-${String(i + 1).padStart(3, "0")}`;
      const [existing] = await sql(
        tx,
        "SELECT id FROM properties WHERE organization_id=$1 AND code=$2",
        [ctx.organizationId, code],
      );
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const property = await createProperty(tx, {
        code,
        title: p.title,
        description: `Inmueble ficticio de demostración. ${p.beds ? `${p.beds} habitaciones y ` : ""}${p.area ? `${p.area} m² de construcción` : `${p.land} m² de terreno`}. Las fotografías son ilustrativas y no documentan una propiedad real.`,
        type: p.type,
        operation: p.operation ?? "VENTA",
        status: "PUBLICADA",
        priceMinor: p.price * 100,
        currency: p.currency ?? "DOP",
        province:
          p.zone === "Distrito Nacional"
            ? "Distrito Nacional"
            : p.zone === "Punta Cana"
              ? "La Altagracia"
              : p.zone.includes("Santo Domingo")
                ? "Santo Domingo"
                : p.zone,
        municipality: p.zone,
        sector: p.sector,
        bedrooms: p.beds,
        bathrooms: p.beds ? 2 : null,
        parking: p.beds ? 2 : null,
        builtArea: p.area,
        landArea: p.land,
        amenities: p.features,
        internalNotes:
          "Datos ficticios de demostración; documentación no verificada.",
        metadata: {
          demo: true,
          negotiable: null,
          documentationVerified: false,
        },
        media: [
          {
            url: `/images/house-${p.photo}.jpg`,
            alt: "Fotografía arquitectónica ilustrativa de demostración",
            width: 1800,
            height: 1200,
          },
          {
            url: `/images/house-${(p.photo % 6) + 1}.jpg`,
            alt: "Vista ilustrativa adicional; no representa una propiedad verificada",
            width: 1800,
            height: 1200,
          },
        ],
      });
      ids.push(property.id);
    }
    const people = [
      {
        name: "Lucía Herrera",
        type: "CASA",
        budget: 800000000,
        zone: "Santo Domingo Este",
      },
      {
        name: "Mateo Rivas",
        type: "APARTAMENTO",
        budget: 650000000,
        zone: "Santo Domingo Este",
      },
      {
        name: "Valeria Cruz",
        type: "VILLA",
        budget: 40000000,
        zone: "Punta Cana",
        currency: "USD",
      },
      {
        name: "Nicolás Peña",
        type: "SOLAR",
        budget: 400000000,
        zone: "Santo Domingo Este",
      },
      {
        name: "Camila Duarte",
        type: "CASA",
        budget: 1500000000,
        zone: "Distrito Nacional",
      },
    ];
    const prospects = [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      prospects.push(
        await createProspect(tx, {
          name: p.name,
          email: `demo-${i + 1}@example.invalid`,
          channel: "DEMO",
          consent: false,
          preferences: {
            currency: p.currency ?? "DOP",
            type: p.type,
            operation: "VENTA",
            budgetMaxMinor: p.budget,
            zones: [p.zone],
            requiredFeatures: i === 0 ? ["piscina", "seguridad privada"] : [],
          },
          notes: "Perfil ficticio de demostración.",
          idempotencyKey: "demo-prospect-" + i,
        }),
      );
    }
    const offers = [];
    for (let i = 0; i < 3; i++) {
      const offer = await createOfferDraft(tx, {
        prospectId: prospects[i].id,
        title: [
          "Vivir con calma, cerca de todo",
          "Una nueva perspectiva de ciudad",
          "Tu refugio junto al Caribe",
        ][i],
        greeting: `Hola, ${people[i].name.split(" ")[0]}`,
        introduction:
          "Selección ficticia de demostración. Explora las propiedades y solicita una visita en modo sandbox.",
        theme: ["MINIMALISTA", "EDITORIAL", "CALIDO"][i],
        propertyIds:
          i === 0
            ? ids.slice(0, 3)
            : i === 1
              ? [ids[3], ids[5], ids[12]]
              : [ids[6]],
        idempotencyKey: "demo-offer-" + i,
        metadata: { demo: true },
      });
      offers.push(offer);
    }
    const existingSlots = await sql(
      tx,
      "SELECT id FROM availability_slots WHERE organization_id=$1",
      [ctx.organizationId],
    );
    const slots = [];
    if (!existingSlots.length) {
      for (let day = 1; day <= 7; day++) {
        for (const hour of [14, 16, 18]) {
          const start = new Date();
          start.setUTCDate(start.getUTCDate() + day);
          start.setUTCHours(hour, 0, 0, 0);
          slots.push(
            await createSlot(tx, {
              startAt: start.toISOString(),
              endAt: new Date(start.getTime() + 3600000).toISOString(),
            }),
          );
        }
      }
    }
    const [seedFlag] = await sql(
      tx,
      "SELECT data->>'visitsSeeded' AS done FROM settings WHERE organization_id=$1",
      [ctx.organizationId],
    );
    if (!seedFlag?.done && slots.length) {
      await publishOffer(tx, offers[0].id, { approved: true });
      for (let i = 0; i < 2; i++) {
        const created = await createVisit(
          tx,
          {
            offerId: offers[0].id,
            propertyId: ids[i],
            slotId: slots[i].id,
            termsAccepted: true,
            termsVersion: "sandbox-v1",
          },
          "DEMO_SEED",
        );
        await sandboxPay(tx, created.payment.id);
      }
      await sql(
        tx,
        'UPDATE settings SET data=data||\'{"visitsSeeded":true,"demoData":true}\'::jsonb WHERE organization_id=$1',
        [ctx.organizationId],
      );
    }
    await sql(
      tx,
      "INSERT INTO terms_versions(organization_id,version,body,approved) VALUES($1,$2,$3,false) ON CONFLICT(organization_id,version) DO NOTHING",
      [ctx.organizationId, "sandbox-v1", termsText()],
    );
    console.log(
      "Seed complete: 15 fictional properties, 5 prospects (no Alejandro), 3 offers, availability and sandbox visits.",
    );
  });
}
if (process.argv[1]?.endsWith("seed.ts"))
  seed()
    .then(() => db.end())
    .catch(async (e) => {
      console.error(e.message);
      await db.end();
      process.exitCode = 1;
    });

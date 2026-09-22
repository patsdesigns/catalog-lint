import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  readProduct,
  setProductField,
  setVariantField,
  setWeight,
  setAlt,
  setCost,
  renameOptionValue,
  onlineStorePublicationId,
  setPublished,
  readAvailable,
  setAvailable,
  readMetafield,
  setMetafield,
} from "./writes.server";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Applies one correction described by a finding's edit descriptor: a value the merchant typed, or
// the suggested one when Quick apply was used. Every change is logged like a bulk fix, so it shows
// under Recent fixes and can be undone. Returns { ok, error, batchId }.
export async function applyEdit(graphql, shop, edit, value) {
  const entries = [];
  const log = (e) => entries.push(e);
  let errs = [];

  if (edit.kind === "product") {
    const current = await readProduct(graphql, edit.productId);
    if (!current) return { ok: false, error: "Product not found" };
    errs = await setProductField(graphql, edit.productId, edit.field, value);
    if (!errs.length) {
      const after =
        edit.field === "tags"
          ? String(value).split(",").map((t) => t.trim()).filter(Boolean)
          : value;
      log({ field: edit.field, targetId: edit.productId, productId: edit.productId, before: current[edit.field], after });
    }
  } else if (edit.kind === "word") {
    const current = await readProduct(graphql, edit.productId);
    if (!current) return { ok: false, error: "Product not found" };
    const before = current[edit.field];
    const re = new RegExp(`\\b${escapeRegex(edit.word)}\\b`, "g");
    const after = Array.isArray(before)
      ? before.map((t) => t.replace(re, value))
      : String(before).replace(re, value);
    errs = await setProductField(graphql, edit.productId, edit.field, after);
    if (!errs.length) log({ field: edit.field, targetId: edit.productId, productId: edit.productId, before, after });
  } else if (edit.kind === "variant") {
    errs = await setVariantField(graphql, edit.productId, edit.variantId, edit.field, value);
    if (!errs.length) log({ field: edit.field, targetId: edit.variantId, productId: edit.productId, before: edit.raw ?? edit.current, after: value });
  } else if (edit.kind === "policy") {
    // Continue selling when out of stock, on every variant of the product.
    for (const variantId of edit.variantIds || []) {
      const e = await setVariantField(graphql, edit.productId, variantId, "inventoryPolicy", value);
      if (e.length) errs.push(...e);
      else log({ field: "inventoryPolicy", targetId: variantId, productId: edit.productId, before: edit.before || "DENY", after: value });
    }
  } else if (edit.kind === "weight") {
    errs = await setWeight(graphql, edit.inventoryItemId, value, edit.unit);
    if (!errs.length) {
      log({
        field: "weight",
        targetId: edit.inventoryItemId,
        productId: edit.productId,
        before: { value: Number(edit.raw ?? edit.current) || 0, unit: edit.unit },
        after: { value: Number(value), unit: edit.unit },
      });
    }
  } else if (edit.kind === "cost") {
    errs = await setCost(graphql, edit.inventoryItemId, value);
    if (!errs.length) log({ field: "cost", targetId: edit.inventoryItemId, productId: edit.productId, before: edit.current === "" ? null : edit.current, after: value });
  } else if (edit.kind === "alt") {
    // One value for every image, or, numbered, the value plus the image number for each.
    const ids = edit.mediaIds || [];
    for (let i = 0; i < ids.length; i++) {
      const alt = edit.numbered ? `${value} ${i + 1}` : value;
      const e = await setAlt(graphql, edit.productId, ids[i], alt);
      if (e.length) errs.push(...e);
      else log({ field: "alt", targetId: ids[i], productId: edit.productId, before: edit.current || "", after: alt });
    }
  } else if (edit.kind === "option") {
    // The other spellings of an option value take the chosen one; each value keeps its id.
    for (const v of edit.values || []) {
      if (v.name === value) continue;
      const e = await renameOptionValue(graphql, edit.productId, edit.optionId, v.id, value);
      if (e.length) errs.push(...e);
      else log({ field: "optionValue", targetId: v.id, productId: edit.productId, before: { optionId: edit.optionId, name: v.name }, after: { optionId: edit.optionId, name: value } });
    }
  } else if (edit.kind === "publish") {
    const publicationId = await onlineStorePublicationId(graphql);
    if (!publicationId) return { ok: false, error: "This store has no Online Store sales channel." };
    errs = await setPublished(graphql, edit.productId, publicationId, true);
    if (!errs.length) log({ field: "publication", targetId: publicationId, productId: edit.productId, before: false, after: true });
  } else if (edit.kind === "inventory") {
    const level = await readAvailable(graphql, edit.inventoryItemId);
    if (!level) return { ok: false, error: "This variant is not stocked at any location." };
    errs = await setAvailable(graphql, edit.inventoryItemId, level.locationId, value);
    if (!errs.length) {
      log({ field: "available", targetId: edit.inventoryItemId, productId: edit.productId, before: level, after: { locationId: level.locationId, quantity: Number(value) } });
    }
  } else if (edit.kind === "metafield") {
    const before = await readMetafield(graphql, edit.productId, edit.key);
    const type = before?.type || edit.type || "single_line_text_field";
    errs = await setMetafield(graphql, edit.productId, edit.key, type, value);
    if (!errs.length) log({ field: "metafield", targetId: edit.key, productId: edit.productId, before, after: { type, value: String(value) } });
  } else if (edit.kind === "metafieldWord") {
    // One word replaced inside the metafield value.
    const before = await readMetafield(graphql, edit.productId, edit.key);
    if (!before) return { ok: false, error: "The metafield is empty now." };
    const re = new RegExp(`\\b${escapeRegex(edit.word)}\\b`, "g");
    const after = String(before.value).replace(re, value);
    const type = before.type || edit.type || "single_line_text_field";
    errs = await setMetafield(graphql, edit.productId, edit.key, type, after);
    if (!errs.length) log({ field: "metafield", targetId: edit.key, productId: edit.productId, before, after: { type, value: after } });
  } else {
    return { ok: false, error: "This finding cannot be edited here" };
  }

  let batchId = null;
  if (entries.length) {
    batchId = randomUUID();
    await prisma.fixLog.createMany({
      data: entries.map((e) => ({
        shop,
        batchId,
        ruleId: edit.ruleId || "edit",
        field: e.field,
        targetId: e.targetId,
        productId: e.productId,
        title: edit.title || "",
        before: JSON.stringify(e.before),
        after: JSON.stringify(e.after),
      })),
    });
  }

  return { ok: errs.length === 0, error: errs.join("; ") || null, batchId };
}

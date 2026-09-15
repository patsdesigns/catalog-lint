import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  readProduct,
  setProductField,
  setVariantField,
  setWeight,
  setAlt,
  setCost,
} from "./writes.server";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Apply one merchant typed correction described by a finding's edit descriptor.
// Returns { ok, error, batchId }.
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
    if (!errs.length) log({ field: edit.field, targetId: edit.variantId, productId: edit.productId, before: edit.current, after: value });
  } else if (edit.kind === "weight") {
    errs = await setWeight(graphql, edit.inventoryItemId, value, edit.unit);
    if (!errs.length) {
      log({
        field: "weight",
        targetId: edit.inventoryItemId,
        productId: edit.productId,
        before: { value: Number(edit.current) || 0, unit: edit.unit },
        after: { value: Number(value), unit: edit.unit },
      });
    }
  } else if (edit.kind === "cost") {
    errs = await setCost(graphql, edit.inventoryItemId, value);
    if (!errs.length) log({ field: "cost", targetId: edit.inventoryItemId, productId: edit.productId, before: edit.current === "" ? null : edit.current, after: value });
  } else if (edit.kind === "alt") {
    for (const mediaId of edit.mediaIds) {
      const e = await setAlt(graphql, edit.productId, mediaId, value);
      if (e.length) errs.push(...e);
      else log({ field: "alt", targetId: mediaId, productId: edit.productId, before: "", after: value });
    }
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

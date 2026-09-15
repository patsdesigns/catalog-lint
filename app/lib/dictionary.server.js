import prisma from "../db.server";

export async function getWords(shop) {
  const rows = await prisma.dictionaryWord.findMany({
    where: { shop },
    select: { word: true },
  });
  return rows.map((r) => r.word);
}

export async function addWord(shop, word) {
  const clean = (word || "").trim().toLowerCase();
  if (!clean) return;
  await prisma.dictionaryWord.upsert({
    where: { shop_word: { shop, word: clean } },
    update: {},
    create: { shop, word: clean },
  });
}

export async function listWords(shop) {
  return prisma.dictionaryWord.findMany({
    where: { shop },
    orderBy: { word: "asc" },
    select: { id: true, word: true },
  });
}

export async function removeWord(shop, id) {
  await prisma.dictionaryWord.deleteMany({ where: { shop, id: Number(id) } });
}

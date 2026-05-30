const fs = require("fs/promises");
const path = require("path");

const BASE_URL = "https://l2hub.info";
const ITEMS_URL = `${BASE_URL}/il/items`;
const OUT_DIR = path.join(__dirname, "..", "data");
const OUT_FILE = path.join(OUT_DIR, "interlude-crafts.json");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function fetchText(url, retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "l2craft-static-data-builder/1.0"
        }
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error;
      await wait(300 * attempt);
    }
  }

  throw lastError;
}

function parsePageData(html) {
  const match = html.match(/window\.__data = ([\s\S]*?);<\/script>/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function normalizeItem(item) {
  return {
    id: item.id,
    itemName: item.itemName,
    name: item.name,
    icon: item.icon,
    defaultPrice: item.defaultPrice || 0,
    recipes: (item.recipes || []).map((recipe) => ({
      mats: recipe.mats.map((mat) => ({ itemId: mat.itemId, count: mat.count })),
      prod: recipe.prod.map((prod) => ({ itemId: prod.itemId, count: prod.count }))
    }))
  };
}

async function getAllItems() {
  const items = [];
  const seen = new Set();
  const firstHtml = await fetchText(ITEMS_URL);
  const firstData = parsePageData(firstHtml);
  const maxPageToProbe = 260;

  for (const item of firstData?.items || []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  const pageNumbers = Array.from({ length: maxPageToProbe - 1 }, (_, index) => index + 2);
  const pageResults = await mapPool(pageNumbers, 10, async (page, index) => {
    const html = await fetchText(`${ITEMS_URL}?p=${page}`);
    const data = parsePageData(html);

    if ((index + 1) % 25 === 0 || page === maxPageToProbe) {
      process.stdout.write(`items pages ${index + 2}/${maxPageToProbe}\n`);
    }

    return data?.items || [];
  });

  for (const pageItems of pageResults) {
    if (!pageItems?.length) break;

    for (const item of pageItems || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

async function getCraftData(recipeId) {
  const html = await fetchText(`${BASE_URL}/il/craft/calc/?items=${recipeId}`);
  const data = parsePageData(html);
  if (!data?.targets?.length) return null;

  return {
    targets: data.targets.map((target) => ({
      item: {
        id: target.item.id,
        itemName: target.item.itemName,
        name: target.item.name,
        icon: target.item.icon
      },
      recipe: {
        mats: target.recipe.mats.map((mat) => ({ itemId: mat.itemId, count: mat.count })),
        prod: target.recipe.prod.map((prod) => ({ itemId: prod.itemId, count: prod.count }))
      },
      rate: target.rate
    })),
    items: data.items.map(normalizeItem)
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const allItems = await getAllItems();
  const recipeItems = allItems.filter((item) => (
    item.name.startsWith("Recipe:") || item.itemName.startsWith("rp_")
  ));

  const craftTargets = [];
  const itemById = new Map();

  await mapPool(recipeItems, 16, async (recipeItem, index) => {
    const craft = await getCraftData(recipeItem.id);

    if (craft) {
      for (const item of craft.items) {
        itemById.set(item.id, item);
      }

      for (const target of craft.targets) {
        craftTargets.push({
          key: `${target.item.id}:${recipeItem.id}`,
          recipeId: recipeItem.id,
          recipeName: recipeItem.name,
          item: target.item,
          recipe: target.recipe,
          rate: target.rate
        });
      }
    }

    if ((index + 1) % 50 === 0 || index === recipeItems.length - 1) {
      process.stdout.write(`recipes ${index + 1}/${recipeItems.length}: crafts ${craftTargets.length}\n`);
    }
  });

  const payload = {
    source: "https://l2hub.info/il",
    generatedAt: new Date().toISOString(),
    targets: craftTargets.sort((a, b) => (
      a.item.name.localeCompare(b.item.name) || a.rate - b.rate || a.recipeId - b.recipeId
    )),
    items: [...itemById.values()].sort((a, b) => a.id - b.id)
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`saved ${OUT_FILE}: ${payload.targets.length} craft targets, ${payload.items.length} items\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

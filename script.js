document.addEventListener("DOMContentLoaded", initializePage);

async function initializePage() {
  const dropdown = document.getElementById("file-dropdown");
  const copyProductsButton = document.getElementById("copy-products");

  try {
    const files = await fetchFolderStructure();
    files.reverse(); // Neueste Dateien zuerst
    populateDropdown(dropdown, files);

    dropdown.addEventListener("change", () => {
      const selectedFile = dropdown.value;
      if (selectedFile) {
        fetchOffers(selectedFile);
      }
    });

    if (files.length > 0) {
      dropdown.value = files[0];
      await fetchOffers(files[0]);
    }

    copyProductsButton.addEventListener("click", copyVisibleProducts);

    attachEventListeners();
    attachSearchFunctionality();
    setupToggleImages();
  } catch (error) {
    console.error("Error initializing page:", error);
  }
}

async function fetchFolderStructure() {
  try {
    const response = await fetch("data/folder-structure.json");
    if (!response.ok) {
      throw new Error(`Failed to fetch folder structure: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error fetching folder structure:", error);
    alert("Fehler: Die Ordnerstruktur konnte nicht geladen werden.");
    return [];
  }
}

function populateDropdown(dropdown, files) {
  dropdown.innerHTML = "";
  files.forEach((file) => {
    const option = document.createElement("option");
    option.value = file;
    // "2026/KW11/2026-03-09.json" → "KW11 — 09.03.2026"
    const match = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
    if (match) {
      option.textContent = `${match[2]} — ${match[5]}.${match[4]}.${match[1]}`;
    } else {
      option.textContent = file;
    }
    dropdown.appendChild(option);
  });
}

async function fetchOffers(filePath) {
  const fullPath = `data/${filePath}`;
  const tableBody = document.getElementById("offer-table");
  const offerInfo = document.getElementById("offer-info");

  try {
    const response = await fetch(fullPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }

    const data = await response.json();
    const { validFrom, validTill, totalCount, offers } = data;

    offerInfo.textContent = `${totalCount} Angebote vom ${formatDate(validFrom)} bis ${formatDate(validTill)}`;

    tableBody.innerHTML = "";
    const fragment = document.createDocumentFragment();
    offers.forEach((offer) => {
      const row = document.createElement("tr");
      row.dataset.category = offer.category.name;

      const cells = [
        offer.id,
        offer.title,
        offer.category.name,
        `${offer.price.value} €`,
        offer.description,
      ];
      cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        row.appendChild(td);
      });

      // Image cell with data attributes
      const imgCell = document.createElement("td");
      imgCell.className = "image-cell hidden";
      imgCell.dataset.imageUrl = offer.images.web90 || "";
      imgCell.dataset.originalUrl = offer.images.original || "";
      row.appendChild(imgCell);

      fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);

    populateCategoryDropdown(offers);
  } catch (error) {
    console.error("Error fetching offers:", error);
    offerInfo.textContent = "Fehler beim Laden der Angebote.";
    tableBody.innerHTML = "";
  }
}

function formatDate(dateStr) {
  // "2026-03-09" → "09.03.2026"
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function populateCategoryDropdown(offers) {
  const categoryFilter = document.getElementById("category-filter");
  if (!categoryFilter) return;

  categoryFilter.innerHTML = "";

  const categoryCounts = offers.reduce((counts, offer) => {
    counts[offer.category.name] = (counts[offer.category.name] || 0) + 1;
    return counts;
  }, {});

  Object.entries(categoryCounts).forEach(([category, count]) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = `${category} (${count})`;
    if (category === "Fleisch & Wurst" || category === "Tiernahrung") {
      option.selected = true;
    }
    categoryFilter.appendChild(option);
  });
}

function hideSelectedCategories() {
  const categoryFilter = document.getElementById("category-filter");
  if (!categoryFilter) return;

  const selectedCategories = Array.from(categoryFilter.selectedOptions).map(
    (o) => o.value
  );
  const rows = document.querySelectorAll("#offer-table tr");

  rows.forEach((row) => {
    if (selectedCategories.includes(row.dataset.category)) {
      row.classList.add("hidden");
    } else {
      row.classList.remove("hidden");
    }
  });
}

function deselectAllCategories() {
  const categoryFilter = document.getElementById("category-filter");
  if (!categoryFilter) return;

  Array.from(categoryFilter.options).forEach((option) => {
    option.selected = false;
  });

  hideSelectedCategories();
}

function attachEventListeners() {
  const deselectCategoriesButton = document.getElementById(
    "deselect-categories"
  );
  const hideSelectedCategoriesButton = document.getElementById(
    "hide-selected-categories"
  );

  if (deselectCategoriesButton) {
    deselectCategoriesButton.addEventListener("click", deselectAllCategories);
  } else {
    console.warn("Deselect Categories button not found.");
  }

  if (hideSelectedCategoriesButton) {
    hideSelectedCategoriesButton.addEventListener(
      "click",
      hideSelectedCategories
    );
  } else {
    console.warn("Hide Selected Categories button not found.");
  }
}

function attachSearchFunctionality() {
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const searchTerm = searchInput.value.toLowerCase();
      const rows = document.querySelectorAll("#offer-table tr");

      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll("td"));
        const matches = cells.some((cell) =>
          cell.textContent.toLowerCase().includes(searchTerm)
        );
        if (matches) {
          row.classList.remove("hidden");
        } else {
          row.classList.add("hidden");
        }
      });
    });
  }
}

function copyVisibleProducts() {
  const rows = document.querySelectorAll("#offer-table tr:not(.hidden)");
  const products = [];

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length) {
      const product = {
        id: cells[0].textContent.trim(),
        title: cells[1].textContent.trim(),
        category: cells[2].textContent.trim(),
        price: cells[3].textContent.trim(),
        description: cells[4].textContent.trim(),
      };
      products.push(product);
    }
  });

  const jsonString = JSON.stringify(products, null, 2);

  // Add LLM-friendly instructions and formatting
  const promptString = `
[LLM PROMPT START]
Below is a JSON list of filtered products. Use this data to answer questions, generate summaries, or provide insights based on the product information.

\`\`\`json
${jsonString}
\`\`\`

Please follow the steps below in your response:
1. Reference product data by 'id' or 'title'.
2. If you need to provide reasoning, consider the context of 'category', 'price', and 'description'.
3. Keep answers factual and based on the provided data.

[LLM PROMPT END]
`;

  navigator.clipboard
    .writeText(promptString)
    .then(() => {
      alert("Sichtbare Produkte wurden als strukturierte LLM-Prompt kopiert!");
    })
    .catch((err) => {
      console.error("Fehler beim Kopieren der Daten:", err);
    });
}

function setupToggleImages() {
  const toggleImagesButton = document.getElementById("toggle-images");
  const imageHeader = document.getElementById("image-column-header");

  if (!toggleImagesButton || !imageHeader) return;

  toggleImagesButton.addEventListener("click", () => {
    const imageCells = document.querySelectorAll(".image-cell");
    const isHidden = imageHeader.classList.contains("hidden");

    imageCells.forEach((cell) => {
      if (isHidden) {
        // Show images
        const imgUrl = cell.getAttribute("data-image-url");
        if (imgUrl && !cell.querySelector("img")) {
          const img = document.createElement("img");
          img.src = imgUrl;
          img.alt = "Produktbild";
          img.style.cursor = "zoom-in";
          cell.appendChild(img);
        }
        cell.classList.remove("hidden");
      } else {
        // Hide images
        if (cell.querySelector("img")) {
          cell.querySelector("img").remove();
        }
        cell.classList.add("hidden");
      }
    });

    imageHeader.classList.toggle("hidden", !isHidden);
    toggleImagesButton.textContent = isHidden
      ? "Bilder ausblenden"
      : "Bilder laden";

    // Attach hover preview if images are shown
    if (isHidden) attachImageHoverPreview();
  });
}

function attachImageHoverPreview() {
  const table = document.getElementById("offer-table");
  const imagePreview = document.getElementById("image-preview");

  if (!table || !imagePreview) return;

  table.addEventListener("mouseover", (event) => {
    const imgCell = event.target.closest(".image-cell img");
    if (!imgCell) return;

    const originalUrl =
      imgCell.closest(".image-cell").dataset.originalUrl || "";
    if (originalUrl) {
      imagePreview.innerHTML = `<img src="${originalUrl}" alt="Vorschau" loading="lazy">`;
      imagePreview.classList.add("visible");
    }
  });

  table.addEventListener("mouseout", (event) => {
    if (event.target.closest(".image-cell img")) {
      imagePreview.innerHTML = "";
      imagePreview.classList.remove("visible");
    }
  });
}

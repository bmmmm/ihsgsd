document.addEventListener("DOMContentLoaded", initializePage);

async function initializePage() {
  const dropdown = document.getElementById("file-dropdown");
  const copyProductsButton = document.getElementById("copy-products");

  try {
    const files = await fetchFolderStructure();
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
    option.textContent = file;
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

    offerInfo.textContent = `${totalCount} Angebote vom ${validFrom} bis ${validTill}`;

    tableBody.innerHTML = "";
    offers.forEach((offer) => {
      const row = document.createElement("tr");
      row.dataset.category = offer.category.name;

      // Use web90 for the thumbnail and original for the hover image
      const web90Url = offer.images.web90 || "";
      const originalUrl = offer.images.original || ""; // fallback if original not found

      row.innerHTML = `
                <td>${offer.id}</td>
                <td>${offer.title}</td>
                <td>${offer.category.name}</td>
                <td>${offer.price.value} €</td>
                <td>${offer.description}</td>
                <td class="image-cell hidden" data-image-url="${web90Url}" data-original-url="${originalUrl}"></td>
            `;
      tableBody.appendChild(row);
    });

    populateCategoryDropdown(offers);
    attachSearchFunctionality();
  } catch (error) {
    console.error("Error fetching offers:", error);
    offerInfo.textContent = "Fehler beim Laden der Angebote.";
    tableBody.innerHTML = "";
  }

  // After offers are loaded, set up image toggling
  toggleImages();
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

function toggleImages() {
  const toggleImagesButton = document.getElementById("toggle-images");
  const imageCells = document.querySelectorAll(".image-cell");
  const imageHeader = document.getElementById("image-column-header");

  if (!toggleImagesButton || imageCells.length === 0 || !imageHeader) return;

  toggleImagesButton.addEventListener("click", () => {
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

  // Position the preview in the top-right corner of the window
  imagePreview.style.position = "fixed";
  imagePreview.style.top = "10px"; // Add some padding from the top
  imagePreview.style.right = "10px"; // Add some padding from the right

  table.addEventListener("mouseover", (event) => {
    const imgCell = event.target.closest(".image-cell img");
    if (!imgCell) return;

    const originalUrl =
      imgCell.closest(".image-cell").dataset.originalUrl || "";
    if (originalUrl) {
      imagePreview.innerHTML = `<img src="${originalUrl}" alt="Vorschau">`;
      imagePreview.style.display = "block";
    }
  });

  table.addEventListener("mouseout", (event) => {
    if (event.target.closest(".image-cell img")) {
      imagePreview.style.display = "none";
      imagePreview.innerHTML = "";
    }
  });
}

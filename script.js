document.addEventListener('DOMContentLoaded', initializePage);

async function initializePage() {
    const dropdown = document.getElementById('file-dropdown');
    const copyProductsButton = document.getElementById('copy-products');

    try {
        // Fetch the file and folder structure dynamically
        const files = await fetchFolderStructure();
        populateDropdown(dropdown, files);

        // Add event listener to load selected file
        dropdown.addEventListener('change', () => {
            const selectedFile = dropdown.value;
            if (selectedFile) {
                fetchOffers(selectedFile);
            }
        });

        // Auto-load the first file in the dropdown, if available
        if (files.length > 0) {
            dropdown.value = files[0];
            fetchOffers(files[0]);
        }

        // Attach copy button functionality
        copyProductsButton.addEventListener('click', copyVisibleProducts);
    } catch (error) {
        console.error("Error initializing page:", error);
    }
}

// Fetch the folder structure (simulate with a static file or server-side API)
async function fetchFolderStructure() {
    try {
        const response = await fetch('data/folder-structure.json');
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

// Populate the dropdown with folder and file options
function populateDropdown(dropdown, files) {
    dropdown.innerHTML = ""; // Clear existing options
    files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file; // Display the full path
        dropdown.appendChild(option);
    });
}

// Fetch offers from the selected file and populate the table
async function fetchOffers(filePath) {
    const fullPath = `data/${filePath}`; // Prepend 'data/' to paths from folder-structure.json
    const tableBody = document.getElementById('offer-table');
    const offerInfo = document.getElementById('offer-info');

    try {
        const response = await fetch(fullPath);
        if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.status}`);
        }

        const data = await response.json();
        const { validFrom, validTill, totalCount, offers } = data;

        // Update info section
        offerInfo.textContent = `${totalCount} Angebote vom ${validFrom} bis ${validTill}`;

        // Populate the table
        tableBody.innerHTML = ""; // Clear existing rows
        offers.forEach(offer => {
            const row = document.createElement('tr');
            row.dataset.category = offer.category.name; // Add category for filtering
            row.innerHTML = `
                <td>${offer.id}</td>
                <td>${offer.title}</td>
                <td>${offer.category.name}</td>
                <td>${offer.price.value} €</td>
                <td>${offer.description}</td>
                <td class="image-cell hidden" data-image-url="${offer.images.app || ''}"></td>
            `;
            tableBody.appendChild(row);
        });

        populateCategoryDropdown(offers); // Populate the category filter
        attachSearchFunctionality(); // Reattach search functionality after new data
    } catch (error) {
        console.error("Error fetching offers:", error);
        offerInfo.textContent = "Fehler beim Laden der Angebote.";
        tableBody.innerHTML = ""; // Clear the table on error
    }
}

// Populate the category dropdown with counts and preselect specific categories
function populateCategoryDropdown(offers) {
    const categoryFilter = document.getElementById('category-filter');
    if (!categoryFilter) return; // Ensure the dropdown exists

    // Clear existing options
    categoryFilter.innerHTML = "";

    // Count offers by category
    const categoryCounts = offers.reduce((counts, offer) => {
        counts[offer.category.name] = (counts[offer.category.name] || 0) + 1;
        return counts;
    }, {});

    // Populate the dropdown
    Object.entries(categoryCounts).forEach(([category, count]) => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = `${category} (${count})`;
        if (category === "Fleisch & Wurst" || category === "Tiernahrung") {
            option.selected = true; // Preselect specific categories
        }
        categoryFilter.appendChild(option);
    });
}

// Automatically hide selected categories
function hideSelectedCategories() {
    const categoryFilter = document.getElementById('category-filter');
    if (!categoryFilter) return; // Ensure the dropdown exists

    const selectedCategories = Array.from(categoryFilter.selectedOptions).map(option => option.value);
    const rows = document.querySelectorAll('#offer-table tr');

    rows.forEach(row => {
        if (selectedCategories.includes(row.dataset.category)) {
            row.classList.add('hidden'); // Hide rows for selected categories
        } else {
            row.classList.remove('hidden'); // Show rows for non-selected categories
        }
    });
}

// Deselect all categories
function deselectAllCategories() {
    const categoryFilter = document.getElementById('category-filter');
    if (!categoryFilter) return;

    Array.from(categoryFilter.options).forEach(option => {
        option.selected = false; // Deselect all options
    });

    hideSelectedCategories(); // Show all rows
}

// Attach event listener for search functionality
function attachSearchFunctionality() {
    const searchInput = document.getElementById('search-input');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const rows = document.querySelectorAll('#offer-table tr');

            rows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                const matches = cells.some(cell => cell.textContent.toLowerCase().includes(searchTerm));
                if (matches) {
                    row.classList.remove('hidden'); // Show matching rows
                } else {
                    row.classList.add('hidden'); // Hide non-matching rows
                }
            });
        });
    }
}

// Copy visible products to clipboard
function copyVisibleProducts() {
    const rows = document.querySelectorAll('#offer-table tr:not(.hidden)');
    const products = [];

    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length) {
            const product = {
                id: cells[0].textContent.trim(),
                title: cells[1].textContent.trim(),
                category: cells[2].textContent.trim(),
                price: cells[3].textContent.trim(),
                description: cells[4].textContent.trim()
            };
            products.push(product);
        }
    });

    const jsonString = JSON.stringify(products, null, 2);

    navigator.clipboard.writeText(jsonString)
        .then(() => {
            alert('Sichtbare Produkte wurden als JSON kopiert!');
        })
        .catch(err => {
            console.error('Fehler beim Kopieren der JSON-Daten:', err);
        });
}

// Attach functionality for buttons and dropdowns
function attachEventListeners() {
    const deselectCategoriesButton = document.getElementById('deselect-categories');
    const hideSelectedCategoriesButton = document.getElementById('hide-selected-categories');

    if (deselectCategoriesButton) {
        deselectCategoriesButton.addEventListener('click', deselectAllCategories);
    }

    if (hideSelectedCategoriesButton) {
        hideSelectedCategoriesButton.addEventListener('click', hideSelectedCategories);
    }
}
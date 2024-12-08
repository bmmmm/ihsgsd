async function fetchOffers() {
    try {
        const response = await fetch('output_raw.json'); // Fetch data from the local JSON file
        const data = await response.json();

        // Extract date range and item count
        const dateRange = `${data.validFrom} - ${data.validTill}`;
        const itemCount = data.totalCount;

        // Update the page title and offer info
        document.getElementById('page-title').textContent = `EDEKA Angebote (${dateRange})`;
        document.getElementById('offer-info').textContent = `${itemCount} Angebote verfügbar`;

        // Populate the table without images
        populateTable(data.offers);

        // Populate the category dropdown
        populateCategoryDropdown(data.offers);

        // Attach event listeners for new functionalities
        attachEventListeners(data.offers);
    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
    }
}

// Populate the table with offers
function populateTable(offers) {
    const tableBody = document.getElementById('offer-table');
    tableBody.innerHTML = ""; // Clear the table

    offers.forEach(offer => {
        const row = document.createElement('tr');
        row.dataset.category = offer.category.name; // Add category for filtering
        row.innerHTML = `
            <td>${offer.id}</td>
            <td>${offer.title}</td>
            <td>${offer.category.name}</td>
            <td>${offer.price.value} €</td>
            <td>${offer.description}</td>
            <td class="image-cell hidden" data-image-url="${offer.images.app}"></td>
        `;
        tableBody.appendChild(row);
    });
}

// Populate the category dropdown with counts and preselect specific categories
function populateCategoryDropdown(offers) {
    const categoryFilter = document.getElementById('category-filter');
    const categoryCounts = offers.reduce((counts, offer) => {
        counts[offer.category.name] = (counts[offer.category.name] || 0) + 1;
        return counts;
    }, {});

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

// Attach event listeners for toggling images, filtering categories, and copying products
function attachEventListeners(offers) {
    const toggleImagesButton = document.getElementById('toggle-images');
    const copyProductsButton = document.getElementById('copy-products');
    const filterCategoryButton = document.getElementById('filter-category');
    const categoryFilter = document.getElementById('category-filter');
    const imagePreview = document.getElementById('image-preview');
    let imagesLoaded = false;

    // Load and show images when the button is clicked
    toggleImagesButton.addEventListener('click', () => {
        const imageHeader = document.getElementById('image-column-header');
        const imageCells = document.querySelectorAll('.image-cell');

        if (!imagesLoaded) {
            // Populate images for the first time
            imageCells.forEach(cell => {
                const imgUrl = cell.getAttribute('data-image-url');
                if (imgUrl) {
                    cell.innerHTML = `<img src="${imgUrl}" alt="Produktbild">`;
                    cell.addEventListener('mouseenter', () => showImagePreview(imgUrl, imagePreview));
                    cell.addEventListener('mouseleave', () => hideImagePreview(imagePreview));
                }
                cell.classList.remove('hidden');
            });
            imageHeader.classList.remove('hidden');
            toggleImagesButton.textContent = 'Bilder ausblenden';
            imagesLoaded = true;
        } else {
            // Toggle visibility of the image column
            imageCells.forEach(cell => cell.classList.toggle('hidden'));
            imageHeader.classList.toggle('hidden');
            toggleImagesButton.textContent = imageCells[0].classList.contains('hidden') ? 'Bilder einblenden' : 'Bilder ausblenden';
        }
    });

    // Hide selected categories
    filterCategoryButton.addEventListener('click', () => {
        const selectedCategories = Array.from(categoryFilter.selectedOptions).map(option => option.value);
        const rows = document.querySelectorAll('#offer-table tr');

        rows.forEach(row => {
            if (selectedCategories.includes(row.dataset.category)) {
                row.classList.add('hidden');
            } else {
                row.classList.remove('hidden');
            }
        });
    });

    // Copy visible products to clipboard
    // Copy visible products to clipboard in JSON format
    copyProductsButton.addEventListener('click', () => {
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

        const jsonString = JSON.stringify(products, null, 2); // Convert to JSON string with pretty formatting

        navigator.clipboard.writeText(jsonString).then(() => {
            alert('Sichtbare Produkte wurden als JSON kopiert!');
        }).catch(err => {
            console.error('Fehler beim Kopieren der JSON-Daten:', err);
        });
    });
}

// Show a larger preview of the image in the top-right corner
function showImagePreview(imgUrl, previewContainer) {
    previewContainer.style.display = 'block';
    previewContainer.style.backgroundImage = `url(${imgUrl})`;
    previewContainer.style.backgroundSize = 'contain';
    previewContainer.style.backgroundRepeat = 'no-repeat';
    previewContainer.style.width = '200px';
    previewContainer.style.height = '200px';
}

// Hide the image preview
function hideImagePreview(previewContainer) {
    previewContainer.style.display = 'none';
}

// Fetch data on page load
document.addEventListener('DOMContentLoaded', fetchOffers);
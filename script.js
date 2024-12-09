// Function to check API status
async function checkApiStatus() {
    const apiEndpoint = "https://www.edeka.de/api/auth-proxy/?path=api%2Foffers%3Flimit%3D999%26marketId%3D5625811";
    const statusButton = document.getElementById('api-status-button');

    try {
        const response = await fetch(apiEndpoint, { method: 'HEAD' }); // Use HEAD to check connectivity
        if (response.ok) {
            updateButtonStatus('API is reachable', 'green');
        } else {
            updateButtonStatus('API not reachable', 'red');
        }
    } catch (error) {
        updateButtonStatus('API not reachable', 'red');
    }
}

// Update button text and color
function updateButtonStatus(message, color) {
    const statusButton = document.getElementById('api-status-button');
    if (!statusButton) return;
    statusButton.textContent = message;
    statusButton.style.backgroundColor = color;
    statusButton.style.color = 'white';
    statusButton.disabled = true; // Prevent interaction
}

async function fetchOffers() {
    try {
        // Construct the path to the JSON file based on the current date
        const currentDate = new Date();
        const year = currentDate.getFullYear();
        const week = `KW${getISOWeek(currentDate)}`;
        const dateString = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD
        const filePath = `data/${year}/${week}/${dateString}.json`;

        const response = await fetch(filePath); // Fetch data from the generated JSON file
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();

        // Extract date range and item count
        const dateRange = `${data.validFrom} - ${data.validTill}`;
        const itemCount = data.totalCount;

        // Update the page title and offer info
        const pageTitle = document.getElementById('page-title');
        const offerInfo = document.getElementById('offer-info');
        if (pageTitle) pageTitle.textContent = `EDEKA Angebote (${dateRange})`;
        if (offerInfo) offerInfo.textContent = `${itemCount} Angebote verfügbar`;

        // Populate the table without images
        populateTable(data.offers);

        // Populate the category dropdown
        populateCategoryDropdown(data.offers);

        // Automatically hide preselected categories
        hideSelectedCategories();

        // Attach event listeners for new functionalities
        attachEventListeners(data.offers);
    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
    }
}

// Populate the table with offers
function populateTable(offers) {
    const tableBody = document.getElementById('offer-table');
    if (!tableBody) return; // Ensure the table body exists
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
    if (!categoryFilter) return; // Ensure the dropdown exists
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

// Automatically hide selected categories
function hideSelectedCategories() {
    const categoryFilter = document.getElementById('category-filter');
    if (!categoryFilter) return; // Ensure the dropdown exists
    const selectedCategories = Array.from(categoryFilter.selectedOptions).map(option => option.value);
    const rows = document.querySelectorAll('#offer-table tr');

    rows.forEach(row => {
        if (selectedCategories.includes(row.dataset.category)) {
            row.classList.add('hidden');
        } else {
            row.classList.remove('hidden');
        }
    });
}

// Attach event listeners for toggling images, searching, and category actions
function attachEventListeners(offers) {
    const toggleImagesButton = document.getElementById('toggle-images');
    const copyProductsButton = document.getElementById('copy-products');
    const searchInput = document.getElementById('search-input');
    const deselectCategoriesButton = document.getElementById('deselect-categories');
    const hideSelectedCategoriesButton = document.getElementById('hide-selected-categories');
    const categoryFilter = document.getElementById('category-filter');
    const imagePreview = document.getElementById('image-preview');

    // Attach only if the elements exist
    if (toggleImagesButton) {
        let imagesLoaded = false;
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
                if (imageHeader) imageHeader.classList.remove('hidden');
                toggleImagesButton.textContent = 'Bilder ausblenden';
                imagesLoaded = true;
            } else {
                // Toggle visibility of the image column
                imageCells.forEach(cell => cell.classList.toggle('hidden'));
                if (imageHeader) imageHeader.classList.toggle('hidden');
                toggleImagesButton.textContent = imageCells[0].classList.contains('hidden') ? 'Bilder einblenden' : 'Bilder ausblenden';
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const rows = document.querySelectorAll('#offer-table tr');

            rows.forEach(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                const matches = cells.some(cell => cell.textContent.toLowerCase().includes(searchTerm));
                if (matches) {
                    row.classList.remove('hidden');
                } else {
                    row.classList.add('hidden');
                }
            });
        });
    }

    if (deselectCategoriesButton) {
        deselectCategoriesButton.addEventListener('click', () => {
            Array.from(categoryFilter.options).forEach(option => {
                option.selected = false;
            });
        });
    }

    if (hideSelectedCategoriesButton) {
        hideSelectedCategoriesButton.addEventListener('click', () => {
            hideSelectedCategories();
        });
    }

    if (copyProductsButton) {
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

            const jsonString = JSON.stringify(products, null, 2);

            navigator.clipboard.writeText(jsonString).then(() => {
                alert('Sichtbare Produkte wurden als JSON kopiert!');
            }).catch(err => {
                console.error('Fehler beim Kopieren der JSON-Daten:', err);
            });
        });
    }
}

// Show a larger preview of the image in the top-right corner
function showImagePreview(imgUrl, previewContainer) {
    if (!previewContainer) return;
    previewContainer.style.display = 'block';
    previewContainer.style.backgroundImage = `url(${imgUrl})`;
    previewContainer.style.backgroundSize = 'contain';
    previewContainer.style.backgroundRepeat = 'no-repeat';
    previewContainer.style.width = '200px';
    previewContainer.style.height = '200px';
}

// Hide the image preview
function hideImagePreview(previewContainer) {
    if (!previewContainer) return;
    previewContainer.style.display = 'none';
}

// Helper function to calculate ISO week number
function getISOWeek(date) {
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7; // ISO week starts on Monday
    target.setDate(target.getDate() - dayNr + 3); // Move to Thursday in the same week
    const firstThursday = new Date(target.getFullYear(), 0, 4); // 4th January is always in week 1
    const diff = target - firstThursday;
    return Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1; // Calculate the week number
}


// Automatically check API status and fetch offers on page load
document.addEventListener('DOMContentLoaded', () => {
    checkApiStatus();
    fetchOffers();
});
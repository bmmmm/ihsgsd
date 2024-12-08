async function fetchOffers() {
    try {
        const response = await fetch('output_raw.json'); // Fetch data from the local JSON file
        const data = await response.json();

        // Extract date range, item count, and regional/national status
        const dateRange = `${data.validFrom} - ${data.validTill}`;
        const itemCount = data.totalCount;
        const isNational = data.national ? "National" : "Regional";

        // Update the page title and offer info
        document.getElementById('page-title').textContent = `EDEKA Angebote (${dateRange}, ${isNational})`;
        document.getElementById('offer-info').textContent = `${itemCount} Angebote verfügbar`;

        // Populate the table
        const tableBody = document.getElementById('offer-table');
        tableBody.innerHTML = ""; // Clear the table

        data.offers.forEach(offer => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${offer.title}</td>
                <td>${offer.category.name}</td>
                <td>${offer.price.value} €</td>
                <td>${offer.description}</td>
                <td><img src="${offer.images.app}" alt="${offer.title}" class="product-image"></td>
            `;
            tableBody.appendChild(row);
        });

        // Attach event listeners for new functionalities
        attachEventListeners();
    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
    }
}

// Attach event listeners for toggling images and copying products
function attachEventListeners() {
    const toggleImagesButton = document.getElementById('toggle-images');
    const copyProductsButton = document.getElementById('copy-products');
    let imagesVisible = true;

    // Toggle image visibility
    toggleImagesButton.addEventListener('click', () => {
        const images = document.querySelectorAll('.product-image');
        images.forEach(img => img.classList.toggle('hidden'));
        imagesVisible = !imagesVisible;
        toggleImagesButton.textContent = imagesVisible ? 'Bilder ausblenden' : 'Bilder einblenden';
    });

    // Copy products to clipboard
    copyProductsButton.addEventListener('click', () => {
        const rows = document.querySelectorAll('#offer-table tr');
        const products = [];

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length) {
                const product = {
                    Produkt: cells[0].textContent,
                    Kategorie: cells[1].textContent,
                    Preis: cells[2].textContent,
                };
                products.push(product);
            }
        });

        const productText = products.map(p => `Produkt: ${p.Produkt}, Kategorie: ${p.Kategorie}, Preis: ${p.Preis}`).join('\n');
        navigator.clipboard.writeText(productText).then(() => {
            alert('Produkte wurden kopiert!');
        }).catch(err => {
            console.error('Fehler beim Kopieren der Produkte:', err);
        });
    });
}

// Fetch data on page load
document.addEventListener('DOMContentLoaded', fetchOffers);
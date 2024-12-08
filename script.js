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
        const tableBody = document.getElementById('offer-table');
        tableBody.innerHTML = ""; // Clear the table

        data.offers.forEach(offer => {
            const row = document.createElement('tr');
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

        // Attach event listeners for new functionalities
        attachEventListeners(data);
    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
    }
}

// Attach event listeners for toggling images and copying products
function attachEventListeners(data) {
    const toggleImagesButton = document.getElementById('toggle-images');
    const copyProductsButton = document.getElementById('copy-products');
    let imagesLoaded = false;

    // Load and show images when the button is clicked
    toggleImagesButton.addEventListener('click', () => {
        const imageCells = document.querySelectorAll('.image-cell');

        if (!imagesLoaded) {
            // Populate images for the first time
            imageCells.forEach(cell => {
                const imgUrl = cell.getAttribute('data-image-url');
                if (imgUrl) {
                    cell.innerHTML = `<img src="${imgUrl}" alt="Produktbild">`;
                    cell.classList.remove('hidden');
                }
            });
            toggleImagesButton.textContent = 'Bilder ausblenden';
            imagesLoaded = true;
        } else {
            // Toggle visibility of the image column
            imageCells.forEach(cell => cell.classList.toggle('hidden'));
            toggleImagesButton.textContent = imageCells[0].classList.contains('hidden') ? 'Bilder einblenden' : 'Bilder ausblenden';
        }
    });

    // Copy products to clipboard
    copyProductsButton.addEventListener('click', () => {
        const rows = document.querySelectorAll('#offer-table tr');
        const products = [];

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length) {
                const product = {
                    ID: cells[0].textContent,
                    Produkt: cells[1].textContent,
                    Kategorie: cells[2].textContent,
                    Preis: cells[3].textContent,
                };
                products.push(product);
            }
        });

        const productText = products.map(p => `ID: ${p.ID}, Produkt: ${p.Produkt}, Kategorie: ${p.Kategorie}, Preis: ${p.Preis}`).join('\n');
        navigator.clipboard.writeText(productText).then(() => {
            alert('Produkte wurden kopiert!');
        }).catch(err => {
            console.error('Fehler beim Kopieren der Produkte:', err);
        });
    });
}

// Fetch data on page load
document.addEventListener('DOMContentLoaded', fetchOffers);
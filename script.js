async function fetchOffers() {
    try {
        const response = await fetch('output_raw.json'); // Fetch data from the local JSON file
        const data = await response.json();

        // Extract date range and item count
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
                <td><img src="${offer.images.app}" alt="${offer.title}"></td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error("Fehler beim Abrufen der Daten:", error);
    }
}

// Fetch data on page load
document.addEventListener('DOMContentLoaded', fetchOffers);
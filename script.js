async function fetchOffers() {
    try {
        const response = await fetch('output_raw.json'); // Fetch data from the local JSON file
        const data = await response.json();

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

async function updateData() {
    try {
        const response = await fetch('https://www.edeka.de/api/gateway/?path=v1%2Foffers%3Flimit%3D999%26marketId%3D5625811');
        const data = await response.json();

        // Save the updated JSON data to the local file
        const updatedData = JSON.stringify(data, null, 2);
        await saveUpdatedJSON(updatedData);

        console.log("JSON-Daten wurden aktualisiert.");
        fetchOffers(); // Refresh the table
    } catch (error) {
        console.error("Fehler beim Aktualisieren der Daten:", error);
    }
}

async function saveUpdatedJSON(updatedData) {
    const blob = new Blob([updatedData], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'output_raw.json';
    a.click();
}

// Ensure DOM is fully loaded before running the script
document.addEventListener('DOMContentLoaded', () => {
    // Fetch data on page load
    fetchOffers();

    // Attach event listener to the "Update Data" button
    const updateButton = document.getElementById('update-data');
    if (updateButton) {
        updateButton.addEventListener('click', updateData);
    }
});
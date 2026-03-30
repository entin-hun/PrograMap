const fs = require('fs');
let code = fs.readFileSync('frontend/app.js', 'utf8');

code = code.replace(
    /const showWater = document\.getElementById\('toggle-water'\)\.checked;\n\s*if \(!showParks && !showTolls && !showWater\) return;/,
    "if (!showParks && !showTolls) return;"
);

// Remove drinking water marker creation in searchOverpassPOIs
code = code.replace(
    /if \(props\.type === "drinking_water" && showWater\) showMarker = true;/g,
    ""
);

code = code.replace(
    /\} else if \(props\.type === "drinking_water"\) \{\s*icon = "💧";\s*markerDiv\.style\.backgroundColor = "#0dcaf0";\s*markerDiv\.style\.borderColor = "#087990";/g,
    ""
);

fs.writeFileSync('frontend/app.js', code);

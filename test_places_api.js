const fs = require('fs');
let code = fs.readFileSync('frontend/app.js', 'utf8');
const searchBlock = /const request = \{\s*textQuery: "drinking water OR water fountain OR public water",\s*locationRestriction: bounds,\s*fields: \["places\.id", "places\.displayName", "places\.location", "places\.websiteURI", "places\.nationalPhoneNumber"\]\s*\};/;

console.log(code.match(searchBlock) !== null ? "Found" : "Not Found");

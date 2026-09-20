# Marketing website content architecture

The website has two primary routes to an offer: Products for defined software capabilities, and Services for work scoped around a business. The homepage introduces both. Work provides evidence, How We Work explains delivery, Pricing explains service partnerships, and Contact provides a shared enquiry route.

## Product hierarchy

- `/products`: the product catalog. Introduce the range, list available products, explain future additions, and help visitors choose between software and services.
- `/website-builder`: the Website Builder detail page. Own its use cases, capabilities, compatibility, limitations, pricing, access and support information.
- `/website-builder-setup`: the Website Builder setup guide. Own detailed instructions and technical prerequisites.

Keep the existing URLs stable. Breadcrumbs express the hierarchy without moving established pages. The catalog uses CollectionPage structured data; product pages and guides use WebPage structured data.

## Adding a product

Add a product article to the catalog's `product-grid`, following the Website Builder card: category, availability, name, outcome, intended audience, access requirements, confirmed price and descriptive links. The grid adapts to additional cards without redesigning the page.

Create a dedicated detail page before linking it. Use a setup guide when the product requires one. Register each new page in `scripts/build-seo.mjs` and `scripts/build-breadcrumbs.mjs`, with Products as the parent. Link back through breadcrumbs and use extensionless canonical URLs.

Publish only confirmed names, features, prices and launch dates. Distinguish an announced product from an available product. Keep future plans outside the available catalog until there is a real product to describe. Do not inherit Website Builder pricing, compatibility or retainer terms for other products.

## Content boundaries

Keep the catalog focused on discovery and selection. Put detailed features and product-specific FAQs on detail pages; put implementation details and troubleshooting in guides. Keep partnership prices on `/pricing` and software prices with each product. Use the existing pricing data attributes where a configured product price is displayed.

After changes, run `npm run seo`, `npm run seo:check`, and `npm run links`. Review desktop and mobile layouts, heading order, keyboard links and card availability labels.

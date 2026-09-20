order: 9
title: A faster website is not just a technical improvement
description: Speed affects trust, experience, search visibility and how many people reach the next step. It is a commercial decision wearing technical clothes.
category: web
tone: cloud
section: Web / Performance
published: 2026-09-20
summary: Speed affects trust, user experience, search visibility and the number of people who reach the next step.

Site speed gets filed under "technical", which is how it ends up at the bottom of a list, below a new photograph on the about page. That filing is a mistake. Speed is not a property of the code. It is the first thing every visitor experiences, before a word has been read, and they form a judgement from it whether or not they could name what they are judging.

## What slow actually costs

**Some people never arrive.** They tap the link, the screen stays white, and they go back. They are not in your analytics as a bounce. They are not in your analytics at all — the script that would have recorded them had not loaded yet. This is the invisible half of the cost, and it is why slow sites tend to look fine in reports.

**The ones who arrive trust it less.** A hesitant, jumpy page reads as an unserious business, in the same way a shop with a flickering light does. Nobody articulates this. Everybody responds to it.

**Search shows it to fewer people.** Page experience is a ranking input, and more importantly a slow page loses to a fast one in every comparison a search engine can make between two otherwise similar results.

**The last step is where it hurts most.** Slowness is most expensive at exactly the moment somebody has decided to act — a form that takes four seconds to acknowledge a tap, a payment page that stalls. That visitor was already convinced, and you lost them anyway.

## Where the weight comes from

In nearly every case, in this order:

**Images.** A photograph exported at 4000 pixels wide, displayed at 600. This is the single most common cause and the easiest to fix: resize, compress, use a modern format, and make sure the page reserves the space so nothing jumps around when the picture lands.

**Third-party scripts.** Analytics, chat widgets, consent tools, font services, tracking pixels. Each is a request to somebody else's server, and your page is now as fast as their slowest day. Count them. Most sites are carrying two or three nobody remembers adding and nobody uses.

**Fonts.** Typefaces loaded from an external service mean a round trip before text can be drawn — and, separately, a copy of every visitor's IP address going somewhere you did not ask them about. Serving them from your own domain is faster and simpler to explain in a privacy policy.

**Doing work in the browser that should have been done once.** Frameworks and in-browser compilers that ship hundreds of kilobytes to produce a page that could have been produced when it was published.

## Measure the right thing

Not "how long does it take to load", which is a number with no agreed meaning. Three questions:

1. **How long until something appears?** A visitor forgives a page that is clearly arriving. They do not forgive a white screen.
2. **How long until it can be used?** A page that looks finished but ignores taps for two seconds is worse than one that looks unfinished.
3. **Does anything move after it appears?** The most irritating failure on the web: text shifts as a late image arrives and the tap lands on the wrong thing.

And measure on the device your visitors have — a mid-range phone on mobile data — rather than a laptop on the office connection. The gap between those two is usually a factor of five, and every decision made on the fast one underestimates the problem.

> Speed is the only part of a website every single visitor experiences, including the ones who leave before they see anything else.

## It is mostly not a rebuild

The reassuring part: the fixes are usually unglamorous and specific. Resize the images. Remove the two scripts nobody uses. Serve the fonts yourself. Reserve space for anything that loads late. Stop shipping a compiler to a phone.

None of that requires starting again, and most of it can be done in an afternoon by someone who knows where to look. The hard part is not the work. It is deciding that four seconds on somebody else's phone is a business problem rather than a technical footnote.

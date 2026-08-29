<div align="center">

# Tashkent Apartments

### Real Estate Search & Deal Discovery Platform

Finds new real estate listings from property owners in Tashkent, filters out agencies, analyzes market prices and delivers relevant listings to Telegram.

**React · JavaScript · Supabase · Telegram Bot · Web Scraping · AI**

</div>

---

## Overview

**Tashkent Apartments** is a real estate aggregation and analysis platform focused on finding property listings from owners in Tashkent.

The system collects listings for **rent and sale** from:

- OLX.uz
- Uybor.uz
- Realting.uz
- Domtut.uz
- Joymee.uz

It filters out real estate agencies, stores listings in Supabase, displays them through a React web application and sends notifications to Telegram.

The platform also calculates market statistics and highlights listings that are significantly below the average market price.

---

## Features

### Real Estate Scraper

- 5 supported sources
- Apartments, houses and commercial properties
- Sale and rental listings
- Scheduled scraping
- Duplicate protection
- Price history tracking
- Telegram notifications
- Source-specific error handling
- Circuit breakers for blocked or failing endpoints

### Owner vs Agency Detection

Agency detection works without AI and uses deterministic rules:

- Multiple property listings from the same seller
- Reused phone numbers across different listings
- Seller accounts identified as organizations or realtors
- Source-specific owner indicators

Listings that cannot be confidently classified are marked as:

> Probably an owner

They are not hidden in order to avoid losing legitimate owner listings.

---

## AI Features

AI is used only where it provides a practical advantage.

### AI Listing Extraction

AI can extract structured information from listing descriptions when regular parsing cannot reliably identify it.

Examples:

- Property area
- Land area
- Renovation
- New building / secondary market
- Legal information
- Other listing characteristics

Fallback chain:

```text
Gemini
   ↓
Groq
   ↓
OpenRouter
   ↓
Mistral
   ↓
SambaNova
   ↓
Cloudflare Workers AI

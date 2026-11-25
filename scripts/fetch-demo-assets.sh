#!/usr/bin/env bash
set -euo pipefail
mkdir -p public/images
ids=(1600596542815-ffad4c1539a9 1600210492486-724fe5c67fb0 1600607687939-ce8a6c25118c 1600585154340-be6161a56a0c 1600566753086-00f18fb6b3ea 1600047509807-ba8f99d2cdde)
for i in "${!ids[@]}"; do
 n=$((i+1))
 curl -fLsS "https://images.unsplash.com/photo-${ids[$i]}?auto=format&fit=crop&w=1920&q=85" -o "public/images/house-$n.jpg"
done

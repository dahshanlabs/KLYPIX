import matplotlib.pyplot as plt
import numpy as np

# Extracted data from the Excel file JPI sheet
# Asset Type breakdown manually extracted from the original data
asset_types = {
    'Machinery & Equipment': 17120000,  # Major machines and equipment including KSA Complex, PP CAM, etc.
    'Buildings': 11970000,  # KSA Complex Civil Works, buildings, renovations, etc.
    'Lab equipment': 882000,  # HPLC, TOC Device, Lab testing equipment, etc.
    'Tools': 1548000  # General tools, punches, balances, etc.
}

# Strategic vs Direct breakdown manually extracted
strategic_direct = {
    'Strategic': 17600000,  # Major strategic projects like KSA Complex
    'Direct': 13920000,  # Direct operational improvements
    'R&D': 500000  # R&D specific projects
}

# Create chart 1: Asset Type Breakdown
plt.figure(figsize=(10, 7))
colors = ['#FF9999', '#66B2FF', '#99FF99', '#FFCC99']
plt.pie(asset_types.values(), labels=asset_types.keys(), autopct='%1.1f%%', 
        colors=colors, startangle=140)
plt.title('Asset Type Breakdown (2025 FY Original Budget)', fontsize=16, fontweight='bold')
plt.axis('equal')
plt.tight_layout()
plt.savefig('C:/Users/HP/Desktop/asset_type_breakdown.png', dpi=300, bbox_inches='tight')
plt.close()

# Create chart 2: Strategic vs Direct Priorities
plt.figure(figsize=(10, 6))
categories = list(strategic_direct.keys())
values = list(strategic_direct.values())
colors = ['#4CAF50', '#2196F3', '#FF9800']

bars = plt.bar(categories, values, color=colors)
plt.title('Strategic vs Direct Priorities (2025 FY Original Budget)', 
          fontsize=16, fontweight='bold')
plt.ylabel('Budget (USD)', fontsize=12)
plt.xlabel('Category', fontsize=12)

# Add value labels on bars
for bar, value in zip(bars, values):
    height = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2., height + height*0.01,
             f'${value:,.0f}', ha='center', va='bottom', fontweight='bold')

plt.xticks(rotation=0)
plt.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.savefig('C:/Users/HP/Desktop/strategic_priorities.png', dpi=300, bbox_inches='tight')
plt.close()

print("Charts created successfully!")
print(f"Total Budget: ${sum(asset_types.values()):,}")
print(f"Asset Types: {asset_types}")
print(f"Strategic/Direct: {strategic_direct}")
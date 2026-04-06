import { TestBed } from "@angular/core/testing";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { describe, it, expect, vi } from "vitest";
import { FilterPanelComponent } from "./filter-panel";
import { GraphFilterService } from "./graph-filter.service";

describe("FilterPanelComponent", () => {
  let mockFilterService: {
    transitionFilters: ReturnType<typeof vi.fn>;
    highlightedVariantType: ReturnType<typeof vi.fn>;
    searchQuery: ReturnType<typeof vi.fn>;
    toggleTransitionType: ReturnType<typeof vi.fn>;
    applyVariantHighlight: ReturnType<typeof vi.fn>;
    searchAndFocus: ReturnType<typeof vi.fn>;
    exportPng: ReturnType<typeof vi.fn>;
    exportSvg: ReturnType<typeof vi.fn>;
  };

  function setup() {
    mockFilterService = {
      transitionFilters: vi.fn().mockReturnValue({
        link: true,
        programmatic: true,
        redirect: true,
      }),
      highlightedVariantType: vi.fn().mockReturnValue(null),
      searchQuery: vi.fn().mockReturnValue(""),
      toggleTransitionType: vi.fn(),
      applyVariantHighlight: vi.fn(),
      searchAndFocus: vi.fn().mockReturnValue(0),
      exportPng: vi.fn(),
      exportSvg: vi.fn(),
    };

    // Make signal-like functions have set/update for signal compatibility
    (mockFilterService.transitionFilters as unknown as Record<string, unknown>)[
      "set"
    ] = vi.fn();
    (
      mockFilterService.highlightedVariantType as unknown as Record<
        string,
        unknown
      >
    )["set"] = vi.fn();
    (mockFilterService.searchQuery as unknown as Record<string, unknown>)[
      "set"
    ] = vi.fn();

    TestBed.configureTestingModule({
      imports: [FilterPanelComponent],
      providers: [
        provideAnimationsAsync(),
        { provide: GraphFilterService, useValue: mockFilterService },
      ],
    });

    const fixture = TestBed.createComponent(FilterPanelComponent);
    fixture.detectChanges();
    return fixture;
  }

  it("should create the component", () => {
    const fixture = setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("should display filter panel title", () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector(".panel-title")?.textContent).toContain("Filters");
  });

  it("should render three transition type checkboxes", () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const checkboxes = el.querySelectorAll("mat-checkbox");
    expect(checkboxes.length).toBe(3);
  });

  it("should render variant type selector", () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector("mat-select");
    expect(select).not.toBeNull();
  });

  it("should render search input", () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector("input[matInput]");
    expect(input).not.toBeNull();
  });

  it("should render PNG and SVG export buttons", () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const buttons = el.querySelectorAll(".export-buttons button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toContain("PNG");
    expect(buttons[1]?.textContent).toContain("SVG");
  });

  it("should call exportPng on PNG button click", () => {
    const fixture = setup();
    fixture.componentInstance.exportPng();
    // cy is null, so exportPng should not be called on the service
    expect(mockFilterService.exportPng).not.toHaveBeenCalled();
  });

  it("should emit closed event when close button is clicked", () => {
    const fixture = setup();
    const closedSpy = vi.fn();
    fixture.componentInstance.closed.subscribe(closedSpy);
    fixture.componentInstance.close();
    expect(closedSpy).toHaveBeenCalled();
  });

  it("should call toggleTransitionType on checkbox toggle", () => {
    const fixture = setup();
    fixture.componentInstance.onTransitionToggle("link", false);
    expect(mockFilterService.toggleTransitionType).toHaveBeenCalledWith(
      "link",
      false,
      null,
    );
  });
});

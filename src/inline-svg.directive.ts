import {
  ComponentFactoryResolver,
  ComponentRef,
  Directive,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  PLATFORM_ID,
  Renderer2,
  SimpleChanges,
  ViewContainerRef,
} from '@angular/core';
import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { Subscription } from 'rxjs';

import { InlineSVGComponent } from './inline-svg.component';
import { SVGCacheService } from './svg-cache.service';
import { InlineSVGService } from './inline-svg.service';
import * as SvgUtil from './svg-util';

@Directive({
  selector: '[inlineSVG]',
  providers: [SVGCacheService]
})
export class InlineSVGDirective implements OnInit, OnChanges, OnDestroy {
  @Input() inlineSVG: string;
  @Input() replaceContents: boolean = true;
  @Input() prepend: boolean = false;
  @Input() injectComponent: boolean = false;
  @Input() cacheSVG: boolean = true;
  @Input() removeSVGAttributes: Array<string>;
  @Input() forceEvalStyles: boolean = false;
  @Input() evalScripts: 'always' | 'once' | 'never' = 'always';
  @Input() fallbackImgUrl: string;
  @Input() onSVGLoaded: (svg: SVGElement, parent: Element | null) => SVGElement;

  @Output() onSVGInserted: EventEmitter<SVGElement> = new EventEmitter<SVGElement>();
  @Output() onSVGFailed: EventEmitter<any> = new EventEmitter<any>();

  /** @internal */
  _prevSVG: SVGElement;

  private _supportsSVG: boolean;

  private _prevUrl: string;

  private _ranScripts: { [url: string]: boolean } = {};

  private _subscription: Subscription;

  private _svgComp: ComponentRef<InlineSVGComponent>;

  constructor(
    private _el: ElementRef,
    private _viewContainerRef: ViewContainerRef,
    private _resolver: ComponentFactoryResolver,
    private _svgCache: SVGCacheService,
    private _renderer: Renderer2,
    private _inlineSVGService: InlineSVGService,
    @Inject(PLATFORM_ID) private platformId: Object) {
    this._supportsSVG = SvgUtil.isSvgSupported();

    // Check if the browser supports embed SVGs
    if (!isPlatformServer(this.platformId) && !this._supportsSVG) {
      this._fail('Embed SVG are not supported by this browser');
    }
  }

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId) && !isPlatformServer(this.platformId)) { return; }

    this._insertSVG();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!isPlatformBrowser(this.platformId) && !isPlatformServer(this.platformId)) { return; }

    if (changes['inlineSVG']) {
      this._insertSVG();
    }
  }

  ngOnDestroy(): void {
    if (this._subscription) {
      this._subscription.unsubscribe();
    }
  }

  private _insertSVG(): void {
    if (!isPlatformServer(this.platformId) && !this._supportsSVG) { return; }

    // Check if a URL was actually passed into the directive
    if (!this.inlineSVG) {
      this._fail('No URL passed to [inlineSVG]');
      return;
    }

    // Short circuit if SVG URL hasn't changed
    if (this.inlineSVG === this._prevUrl) {
      return;
    }
    this._prevUrl = this.inlineSVG;

    this._subscription = this._svgCache.getSVG(this.inlineSVG, this.cacheSVG)
      .subscribe(
        (svg: SVGElement) => {
          if (SvgUtil.isUrlSymbol(this.inlineSVG)) {
            const symbolId = this.inlineSVG.split('#')[1];
            svg = SvgUtil.createSymbolSvg(this._renderer, svg, symbolId);
          }

          this._processSvg(svg);
        },
        (err: any) => {
          this._fail(err);
        }
      );
  }

  /**
   * The actual processing (manipulation, lifecycle, etc.) and displaying of the
   * SVG.
   *
   * @param svg The SVG to display within the directive element.
   */
  private _processSvg(svg: SVGElement) {
    if (!svg) { return; }

    if (this.removeSVGAttributes && isPlatformBrowser(this.platformId)) {
      SvgUtil.removeAttributes(svg, this.removeSVGAttributes);
    }

    if (this.onSVGLoaded) {
      svg = this.onSVGLoaded(svg, this._el.nativeElement);
    }

    this._insertEl(svg);

    this._evalScripts(svg);

    // Force evaluation of <style> tags since IE doesn't do it.
    // See https://github.com/arkon/ng-inline-svg/issues/17
    if (this.forceEvalStyles) {
      const styleTags = svg.querySelectorAll('style');
      Array.from(styleTags).forEach(tag => tag.textContent += '');
    }

    this.onSVGInserted.emit(svg);
  }

  /**
   * Handles the insertion of the directive contents, which could be an SVG
   * element or a component.
   *
   * @param el The element to put within the directive.
   */
  private _insertEl(el: Element): void {
    if (this.injectComponent) {
      if (!this._svgComp) {
        const factory = this._resolver.resolveComponentFactory(InlineSVGComponent);
        this._svgComp = this._viewContainerRef.createComponent(factory);
      }

      this._svgComp.instance.context = this;
      this._svgComp.instance.replaceContents = this.replaceContents;
      this._svgComp.instance.prepend = this.prepend;
      this._svgComp.instance.content = el;

      // Force element to be inside the directive element inside of adjacent
      this._renderer.appendChild(
        this._el.nativeElement,
        this._svgComp.injector.get(InlineSVGComponent)._el.nativeElement
      );
    } else {
      this._inlineSVGService.insertEl(this, this._el.nativeElement, el, this.replaceContents, this.prepend);
    }
  }

  /**
   * Executes scripts from within the SVG.
   * Based off of code from https://github.com/iconic/SVGInjector
   *
   * @param svg SVG with scripts to evaluate.
   */
  private _evalScripts(svg: SVGElement): void {
    if (!isPlatformBrowser(this.platformId)) { return; }

    const scripts = svg.querySelectorAll('script');
    const scriptsToEval = [];
    let script, scriptType;

    // Fetch scripts from SVG
    for (let i = 0; i < scripts.length; i++) {
      scriptType = scripts[i].getAttribute('type');

      if (!scriptType || scriptType === 'application/ecmascript' || scriptType === 'application/javascript') {
        script = scripts[i].innerText || scripts[i].textContent;
        scriptsToEval.push(script);
        this._renderer.removeChild(scripts[i].parentNode, scripts[i]);
      }
    }

    // Run scripts in closure as needed
    if (scriptsToEval.length > 0 && (this.evalScripts === 'always' ||
      (this.evalScripts === 'once' && !this._ranScripts[this.inlineSVG]))) {
      for (let i = 0; i < scriptsToEval.length; i++) {
        new Function(scriptsToEval[i])(window);
      }

      this._ranScripts[this.inlineSVG] = true;
    }
  }

  private _fail(msg: string): void {
    this.onSVGFailed.emit(msg);

    // Insert fallback image, if specified
    if (this.fallbackImgUrl) {
      const elImg = this._renderer.createElement('IMG');
      this._renderer.setAttribute(elImg, 'src', this.fallbackImgUrl);

      this._insertEl(elImg);
    }
  }

}

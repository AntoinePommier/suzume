import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { readerControlFadeDuration } from "../readerTheme";

export function useReaderControls() {
	const [readerControlsVisible, setReaderControlsVisible] = useState(false);
	const [pageIndicatorExpanded, setPageIndicatorExpanded] = useState(false);
	const readerControlsAnimation = useRef(new Animated.Value(0)).current;
	const pageIndicatorOpacity = useRef(new Animated.Value(1)).current;

	useEffect(() => {
		Animated.timing(readerControlsAnimation, {
			toValue: readerControlsVisible ? 1 : 0,
			duration: readerControlFadeDuration,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: true,
		}).start();
	}, [readerControlsAnimation, readerControlsVisible]);

	useEffect(() => {
		let isCancelled = false;

		Animated.timing(pageIndicatorOpacity, {
			toValue: 0,
			duration: readerControlFadeDuration,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: true,
		}).start(() => {
			if (isCancelled) {
				return;
			}

			setPageIndicatorExpanded(readerControlsVisible);

			Animated.timing(pageIndicatorOpacity, {
				toValue: 1,
				duration: readerControlFadeDuration,
				easing: Easing.out(Easing.cubic),
				useNativeDriver: true,
			}).start();
		});

		return () => {
			isCancelled = true;
			pageIndicatorOpacity.stopAnimation();
		};
	}, [pageIndicatorOpacity, readerControlsVisible]);

	const readerControlsAnimatedStyle = useMemo(
		() => ({
			opacity: readerControlsAnimation,
		}),
		[readerControlsAnimation],
	);

	return {
		readerControlsVisible,
		setReaderControlsVisible,
		pageIndicatorExpanded,
		setPageIndicatorExpanded,
		pageIndicatorOpacity,
		readerControlsAnimatedStyle,
	};
}
